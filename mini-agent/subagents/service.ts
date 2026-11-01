import { Service, type Context } from "@deepseek-ai/cordis"
import {
  installAgentRuntime,
  isolateAgentRuntime,
  type InstalledAgentRuntime,
} from "../agent/runtime.js"
import type { AgentRunResult } from "../agent/service.js"
import type { Session } from "../session/session.js"
import type { ApprovalService } from "../tools/approval.js"
import type {
  Lineage,
  SubagentResult,
  SubagentRun,
  SubagentSetup,
  SubagentToolError,
} from "./types.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    subagents: SubagentService
  }
}

export type SubagentServiceOptions = {
  maxDepth?: number
}

export type SubagentStartOptions = {
  prompt: string
  name?: string
  setup?: SubagentSetup
  signal?: AbortSignal
}

type ActiveRun = {
  controller: AbortController
  context: Context
  run: SubagentRun
}

type PendingStart = {
  controller: AbortController
  done: Promise<void>
}

/** 创建并管理进程内 one-shot 子 Agent。 */
export class SubagentService extends Service {
  static inject = ["llm"]

  readonly maxDepth: number
  private readonly active = new Map<string, ActiveRun>()
  private readonly activationDepths = new Map<string, number>()
  private readonly pending = new Set<PendingStart>()
  private closed = false
  private closePromise?: Promise<void>

  constructor(ctx: Context, options: SubagentServiceOptions = {}) {
    super(ctx, "subagents")
    this.maxDepth = positiveInteger(options.maxDepth ?? 3, "maxDepth")
    ctx.effect(() => () => this.close(), "subagent runs")
  }

  /** 配置并启动一次前台子 Agent；setup 成功前不会创建子 Session。 */
  async start(
    parent: Context,
    options: SubagentStartOptions,
  ): Promise<SubagentRun> {
    this.assertOpen()
    if (options.prompt.trim().length === 0) {
      throw new Error("subagent prompt must not be empty")
    }
    options.signal?.throwIfAborted()

    const parentSession = parent.agent.session
    const cwd = parentSession.cwd
    if (!cwd) throw new Error("parent Session has no workspace")
    // Capture the parent's concrete approval service before entering the child
    // context. Reading parent.approval lazily from the child callback would
    // let Cordis rebind the property to the child's isolated service.
    const parentApproval = parent.get("approval") as ApprovalService | undefined
    if (!parentApproval) throw new Error("parent approval service is unavailable")

    const parentRuntimeDepth = this.activationDepths.get(parentSession.sessionId)
      ?? parentSession.delegationDepth
    const lineage: Lineage = {
      parentSession: parentSession.sessionId,
      delegationDepth: parentSession.delegationDepth + 1,
      subagentDepth: parentRuntimeDepth + 1,
    }
    if (
      lineage.delegationDepth > this.maxDepth
      || lineage.subagentDepth > this.maxDepth
    ) {
      throw new Error(`subagent delegation exceeds max depth ${this.maxDepth}`)
    }

    const controller = new AbortController()
    let removeExternalAbort = () => {}
    if (options.signal) {
      const onAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(options.signal?.reason ?? "parent aborted")
        }
      }
      options.signal.addEventListener("abort", onAbort, { once: true })
      removeExternalAbort = () => options.signal?.removeEventListener("abort", onAbort)
    }
    const pendingDone = Promise.withResolvers<void>()
    const pending: PendingStart = {
      controller,
      done: pendingDone.promise,
    }
    this.pending.add(pending)

    let runtime: InstalledAgentRuntime | undefined
    let published = false
    try {
      const isolated = isolateAgentRuntime(parent)
      runtime = await installAgentRuntime(isolated, { ...parent.agent.options })
      const child = runtime.context
      // 子 Agent 使用独立的 ApprovalService；把请求显式转发到父服务，
      // 这样最终仍由父 TUI 决定，而不是在子作用域落入 unavailable。
      let forwardingApproval = false
      const removeApprovalProxy = child.on(
        "approval/request",
        async (request, next) => {
          // parent.approval.request() dispatches the same event on the shared
          // Cordis bus. Do not proxy that re-entry back to the parent again;
          // continue to the actual parent/TUI handler instead.
          if (forwardingApproval) return next()
          forwardingApproval = true
          try {
            return await parentApproval.request(request, controller.signal)
          } finally {
            forwardingApproval = false
          }
        },
      )
      const onControllerAbort = () => {
        child.agent.cancel(controller.signal.reason ?? "subagent aborted")
      }
      controller.signal.addEventListener("abort", onControllerAbort, { once: true })
      await options.setup?.(child, controller.signal)
      controller.signal.throwIfAborted()
      this.assertOpen()

      const session = child.sessions.create({
        cwd,
        name: options.name?.trim() || "Subagent",
        lineage: {
          parentSession: lineage.parentSession,
          delegationDepth: lineage.delegationDepth,
        },
      })
      child.sessions.select(session.sessionId)
      this.activationDepths.set(session.sessionId, lineage.subagentDepth)

      // 父 Session 持有 child 的持久化目录记录；setup 失败不会留下可发现的 child。
      await parentSession.append({
        type: "subagent/catalog",
        data: {
          childSessionId: session.sessionId,
          mode: "one-shot",
          name: session.sessionName,
          delegationDepth: lineage.delegationDepth,
          createdAt: Date.now(),
        },
      })

      let cleaned = false
      const cleanup = async (): Promise<void> => {
        if (cleaned) return
        cleaned = true
        removeExternalAbort()
        removeApprovalProxy()
        controller.signal.removeEventListener("abort", onControllerAbort)
        this.active.delete(session.sessionId)
        this.activationDepths.delete(session.sessionId)
        await disposeChild(runtime)
      }
      const result = this.runOnce(
        child,
        session.sessionId,
        options.prompt,
        parentSession,
        cleanup,
      )
      const run: SubagentRun = Object.freeze({
        id: session.sessionId,
        result,
        async dispose() {
          if (!controller.signal.aborted) controller.abort("subagent disposed")
          child.agent.cancel("subagent disposed")
          await result
        },
      })
      this.active.set(session.sessionId, { controller, context: child, run })
      published = true
      return run
    } catch (error) {
      if (!controller.signal.aborted) controller.abort("subagent setup failed")
      try {
        await disposeChild(runtime)
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          "Subagent setup and cleanup both failed",
        )
      }
      throw error
    } finally {
      this.pending.delete(pending)
      pendingDone.resolve()
      if (!published) removeExternalAbort()
    }
  }

  /** 停止所有 setup 或运行中的子 Agent，并等待它们收敛。 */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    for (const item of this.pending) item.controller.abort("subagent service closed")
    for (const item of this.active.values()) {
      item.controller.abort("subagent service closed")
      item.context.agent.cancel("subagent service closed")
    }
    this.closePromise = Promise.allSettled([
      ...[...this.pending].map(({ done }) => done),
      ...[...this.active.values()].map(({ run }) => run.result),
    ]).then(() => undefined)
    return this.closePromise
  }

  private async runOnce(
    child: Context,
    childSessionId: string,
    prompt: string,
    parentSession: Session,
    cleanup: () => Promise<void>,
  ): Promise<SubagentResult> {
    let result: SubagentResult
    try {
      result = normalizeResult(
        childSessionId,
        await child.agent.run({ userText: prompt }),
      )
    } catch (error) {
      result = {
        childSessionId,
        finalText: "",
        stopReason: "error",
        error: errorMessage(error),
        toolErrors: [],
      }
    }

    let settlementError: unknown
    try {
      await parentSession.append({
        type: "subagent/settled",
        data: {
          childSessionId,
          stopReason: result.stopReason,
          finishedAt: Date.now(),
        },
      })
    } catch (error) {
      settlementError = error
    }

    try {
      await cleanup()
    } catch (error) {
      return {
        childSessionId,
        finalText: result.finalText,
        stopReason: "error",
        error: [
          result.error,
          settlementError ? `settlement failed: ${errorMessage(settlementError)}` : undefined,
          `cleanup failed: ${errorMessage(error)}`,
        ].filter(Boolean).join("; "),
        toolErrors: result.toolErrors,
      }
    }

    if (settlementError) {
      return {
        childSessionId,
        finalText: result.finalText,
        stopReason: "error",
        error: [
          result.error,
          `settlement failed: ${errorMessage(settlementError)}`,
        ].filter(Boolean).join("; "),
        toolErrors: result.toolErrors,
      }
    }

    return result
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Subagent service is closed")
  }
}

function normalizeResult(
  childSessionId: string,
  result: AgentRunResult,
): SubagentResult {
  const toolErrors: SubagentToolError[] = result.messages.flatMap((message) =>
    message.role === "tool" && message.isError
      ? [{ toolCallId: message.toolCallId, text: message.text }]
      : [],
  )
  return {
    childSessionId,
    finalText: result.finalText,
    stopReason: result.reason.kind,
    ...(result.reason.kind === "error" ? { error: result.reason.error } : {}),
    toolErrors,
  }
}

async function disposeChild(
  runtime?: InstalledAgentRuntime,
): Promise<void> {
  await runtime?.dispose()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
