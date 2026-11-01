import { Service, type Context } from "@deepseek-ai/cordis"
import type {
  JobDoneListener,
  JobOwner,
  JobRead,
  JobSnapshot,
  JobStart,
  JobStatus,
} from "./types.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    jobs: JobService
  }
}

export type JobServiceOptions = {
  /** 单个 Session 同时处于 running/stopping 的任务上限。 */
  maxActivePerOwner?: number
}

type TrackedJob = JobSnapshot & {
  owner?: JobOwner
  abort: AbortController
  output: string
  readOffset: number
  done: Promise<JobStatus>
}

/** 管理进程内后台任务；具体资源仍由启动任务的工具持有。 */
export class JobService extends Service {
  readonly options: Required<JobServiceOptions>
  private readonly jobs = new Map<string, TrackedJob>()
  private readonly counters = new Map<string, number>()
  private readonly listeners = new Set<JobDoneListener>()
  private closed = false
  private listenersClosed = false
  private closePromise?: Promise<void>

  constructor(ctx: Context, options: JobServiceOptions = {}) {
    super(ctx, "jobs")
    this.options = {
      maxActivePerOwner: positiveInteger(
        options.maxActivePerOwner ?? 4,
        "maxActivePerOwner",
      ),
    }
    ctx.effect(
      () => () => this.close(),
      "background jobs",
    )
  }

  /** 启动任务并立即返回快照，不等待任务完成。 */
  start(spec: JobStart): JobSnapshot {
    this.assertOpen()
    if (!spec.kind.trim()) throw new Error("job kind must not be empty")
    if (!spec.label.trim()) throw new Error("job label must not be empty")

    const ownerSession = spec.owner?.sessionId ?? spec.ownerSession
    if (ownerSession && this.activeCount(ownerSession) >= this.options.maxActivePerOwner) {
      throw new Error(
        `Background job limit reached for session ${ownerSession} `
          + `(${this.options.maxActivePerOwner})`,
      )
    }

    const count = (this.counters.get(spec.kind) ?? 0) + 1
    this.counters.set(spec.kind, count)
    const abort = new AbortController()
    const job: TrackedJob = {
      id: `${spec.kind}-${count}`,
      kind: spec.kind,
      label: spec.label,
      ...(spec.owner ? { owner: spec.owner } : {}),
      ...(ownerSession ? { ownerSession } : {}),
      status: "running",
      startedAt: Date.now(),
      abort,
      output: "",
      readOffset: 0,
      done: Promise.resolve("running"),
    }

    this.jobs.set(job.id, job)

    let started: void | Promise<void>
    try {
      // Producer 要同步接收 signal；否则 start 后立即 kill 可能发生在
      // producer 注册 abort listener 之前，任务会永远停在 stopping。
      started = spec.run({
        signal: abort.signal,
        write: (chunk) => {
          // kill 之后生产者可能仍有迟到输出，这些输出不再属于该任务。
          if (job.status === "running") job.output += String(chunk)
        },
      })
    } catch (error) {
      started = Promise.reject(error)
    }

    job.done = Promise.resolve(started)
      .then(
        () => this.settle(job, job.status === "stopping" ? "killed" : "completed"),
        (error: unknown) => {
          if (job.status === "stopping" || abort.signal.aborted) {
            return this.settle(job, "killed")
          }
          const detail = error instanceof Error ? error.message : String(error)
          if (detail) job.output += `${job.output.endsWith("\n") || !job.output ? "" : "\n"}Error: ${detail}\n`
          return this.settle(job, "failed", detail)
        },
      )
    return this.snapshot(job)
  }

  list(ownerSession?: string): JobSnapshot[] {
    return [...this.jobs.values()]
      .filter((job) => this.canAccess(job, ownerSession))
      .map((job) => this.snapshot(job))
  }

  get(id: string, ownerSession?: string): JobSnapshot {
    return this.snapshot(this.expectOwned(id, ownerSession))
  }

  /** 读取从上一次 read 之后新增的输出。 */
  read(id: string, ownerSession?: string): JobRead {
    const job = this.expectOwned(id, ownerSession)
    const text = job.output.slice(job.readOffset)
    job.readOffset = job.output.length
    return { text, job: this.snapshot(job) }
  }

  kill(id: string, ownerSession?: string): "requested" | "already-finished" {
    const job = this.expectOwned(id, ownerSession)
    if (isTerminal(job.status)) return "already-finished"
    if (job.status === "running") {
      job.status = "stopping"
      job.abort.abort("job killed")
    }
    return "requested"
  }

  /** 等待任务完成或超时；超时不会停止任务。 */
  async wait(
    id: string,
    timeoutMs: number,
    ownerSession?: string,
    signal?: AbortSignal,
  ): Promise<JobSnapshot> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeout_ms must be a positive number")
    }
    const job = this.expectOwned(id, ownerSession)
    if (isTerminal(job.status)) return this.snapshot(job)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, timeoutMs)
      const onAbort = () => {
        cleanup()
        reject(signal?.reason ?? new Error("job wait aborted"))
      }
      const onDone = () => {
        cleanup()
        resolve()
      }
      function cleanup() {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      function finish() {
        cleanup()
        resolve()
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      void job.done.then(onDone)
    })
    return this.snapshot(job)
  }

  onDone(listener: JobDoneListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.listenersClosed = true
    for (const job of this.jobs.values()) {
      if (!isTerminal(job.status)) this.kill(job.id, job.ownerSession)
    }
    this.closePromise = Promise.all(
      [...this.jobs.values()].map((job) => job.done),
    ).then(() => {
      this.listeners.clear()
      this.jobs.clear()
    })
    return this.closePromise
  }

  private settle(job: TrackedJob, status: JobStatus, detail?: string): JobStatus {
    if (isTerminal(job.status)) return job.status
    job.status = status
    job.finishedAt = Date.now()
    if (detail) job.detail = detail
    const snapshot = this.snapshot(job)
    if (this.listenersClosed) return status
    for (const listener of this.listeners) {
      try {
        const result = listener(snapshot, job.owner)
        void Promise.resolve(result).catch((error: unknown) => {
          console.warn(`job completion listener rejected: ${String(error)}`)
        })
      } catch (error) {
        console.warn(`job completion listener threw: ${String(error)}`)
      }
    }
    return status
  }

  private expectOwned(id: string, ownerSession?: string): TrackedJob {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`Unknown background job: ${id}`)
    if (!this.canAccess(job, ownerSession)) {
      throw new Error(`Background job ${id} belongs to another session`)
    }
    return job
  }

  private canAccess(job: TrackedJob, ownerSession?: string): boolean {
    return job.ownerSession === undefined || job.ownerSession === ownerSession
  }

  private activeCount(ownerSession: string): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (job.ownerSession === ownerSession && !isTerminal(job.status)) count += 1
    }
    return count
  }

  private snapshot(job: TrackedJob): JobSnapshot {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      ...(job.ownerSession ? { ownerSession: job.ownerSession } : {}),
      status: job.status,
      ...(job.detail ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Job service is closed")
  }
}

function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed"
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
