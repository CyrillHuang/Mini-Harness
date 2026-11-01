import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  sessionCatalogPath,
  sessionPath,
  sessionsDir,
} from "./storage-path.js"

export type SessionSummary = Readonly<{
  id: string
  name: string
  cwd: string
  parentSession?: string
  delegationDepth: number
  filePath: string
  createdAt: number
  updatedAt: number
}>

type CatalogFile = {
  version: 1
  sessions: SessionSummary[]
}

/** 维护根 Session 摘要索引；子 Agent 通过父 Session 目录查询。 */
export class SessionCatalog {
  readonly filePath: string
  private readonly directory: string
  private readonly env: NodeJS.ProcessEnv
  private readonly records = new Map<string, SessionSummary>()
  private loaded = false
  private loading?: Promise<void>
  private writing: Promise<void> = Promise.resolve()

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env
    this.filePath = sessionCatalogPath(env)
    this.directory = sessionsDir(env)
  }

  /** 列出磁盘上属于指定 workspace 的 Session。 */
  async list(cwd?: string): Promise<SessionSummary[]> {
    await this.ensureLoaded()
    const changed = await this.scanDisk()
    if (changed) await this.persist()

    return [...this.records.values()]
      .filter((summary) => cwd === undefined || summary.cwd === cwd)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      )
  }

  /** 获取指定 Session 的磁盘摘要。 */
  async get(sessionId: string): Promise<SessionSummary | undefined> {
    await this.ensureLoaded()
    const changed = await this.scanDisk()
    if (changed) await this.persist()
    return this.records.get(sessionId)
  }

  /** 列出某个父 Session 的内部子 Agent，不混入普通 Session catalog。 */
  async listChildren(parentSessionId: string): Promise<SessionSummary[]> {
    const summaries = await this.readDiskSummaries()
    return summaries
      .filter((summary) => summary.parentSession === parentSessionId)
      .sort((left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      )
  }

  /** 通过父 Session 校验并读取一个内部 child。 */
  async getChild(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<SessionSummary | undefined> {
    const summary = (await this.readDiskSummaries())
      .find((candidate) =>
        candidate.id === childSessionId && candidate.parentSession === parentSessionId,
      )
    return summary
  }

  /** 登记一个已经产生事件的 Session。 */
  async register(summary: SessionSummary): Promise<void> {
    if (summary.parentSession !== undefined) {
      throw new Error("child Session must be discovered through its parent")
    }
    await this.ensureLoaded()
    const previous = this.records.get(summary.id)
    if (previous && sameSummary(previous, summary)) return
    this.records.set(summary.id, summary)
    await this.persist()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loading ??= this.loadCatalog()
    await this.loading
  }

  private async loadCatalog(): Promise<void> {
    try {
      const source = await readFile(this.filePath, "utf8")
      const value = JSON.parse(source) as Partial<CatalogFile>
      if (value.version !== 1 || !Array.isArray(value.sessions)) {
        throw new Error(`Invalid Session catalog: ${this.filePath}`)
      }

      for (const candidate of value.sessions) {
        const summary = normalizeSummary(candidate)
        if (summary) this.records.set(summary.id, summary)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    } finally {
      this.loaded = true
    }
  }

  private async scanDisk(): Promise<boolean> {
    const summaries = await this.readDiskSummaries()
    const diskIds = new Set<string>()
    let changed = false
    for (const summary of summaries) {
      if (summary.parentSession !== undefined) continue
      diskIds.add(summary.id)
      const previous = this.records.get(summary.id)
      if (!previous || !sameSummary(previous, summary)) {
        this.records.set(summary.id, summary)
        changed = true
      }
    }

    for (const id of this.records.keys()) {
      if (!diskIds.has(id)) {
        this.records.delete(id)
        changed = true
      }
    }
    return changed
  }

  private async readDiskSummaries(): Promise<SessionSummary[]> {
    let files
    try {
      files = await readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }

    const summaries: SessionSummary[] = []
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
      const summary = await readSummary(resolve(this.directory, file.name), this.env)
      if (summary) summaries.push(summary)
    }
    return summaries
  }

  private persist(): Promise<void> {
    const write = this.writing.then(async () => {
      const value: CatalogFile = {
        version: 1,
        sessions: [...this.records.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      }
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, JSON.stringify(value, null, 2) + "\n", "utf8")
    })
    this.writing = write.then(() => undefined, () => undefined)
    return write
  }
}

async function readSummary(
  filePath: string,
  env: NodeJS.ProcessEnv,
): Promise<SessionSummary | undefined> {
  let source: string
  try {
    source = await readFile(filePath, "utf8")
  } catch {
    return undefined
  }

  const lines = source.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const firstLine = lines[0]
  if (!firstLine) return undefined

  let record: unknown
  try {
    record = JSON.parse(firstLine)
  } catch {
    return undefined
  }

  if (!record || typeof record !== "object") return undefined
  const candidate = record as {
    type?: unknown
    data?: {
      sessionId?: unknown
      sessionName?: unknown
      cwd?: unknown
      parentSession?: unknown
      delegationDepth?: unknown
    }
    time?: unknown
  }
  const data = candidate.data
  const time = candidate.time
  const delegationDepth = data?.delegationDepth ?? 0
  if (
    !data ||
    candidate.type !== "session/start" ||
    typeof data.sessionId !== "string" ||
    typeof data.sessionName !== "string" ||
    typeof data.cwd !== "string" ||
    !isSessionLineage(data.parentSession, delegationDepth) ||
    typeof time !== "number" ||
    !Number.isSafeInteger(time)
  ) return undefined

  let expectedPath: string
  try {
    expectedPath = sessionPath(data.sessionId, env)
  } catch {
    return undefined
  }
  if (resolve(filePath) !== resolve(expectedPath)) return undefined

  let sessionName = data.sessionName
  for (const line of lines.slice(1)) {
    let next: unknown
    try {
      next = JSON.parse(line)
    } catch {
      continue
    }
    if (!next || typeof next !== "object") continue
    const rename = next as {
      type?: unknown
      data?: { sessionId?: unknown; sessionName?: unknown }
    }
    if (
      rename.type === "session/rename" &&
      rename.data?.sessionId === data.sessionId &&
      typeof rename.data.sessionName === "string" &&
      rename.data.sessionName.trim().length > 0
    ) {
      sessionName = rename.data.sessionName
    }
  }

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch {
    return undefined
  }
  return {
    id: data.sessionId,
    name: sessionName,
    cwd: data.cwd,
    ...(typeof data.parentSession === "string"
      ? { parentSession: data.parentSession }
      : {}),
    delegationDepth: Number(delegationDepth),
    filePath: resolve(filePath),
    createdAt: time,
    updatedAt: Math.max(time, fileStat.mtimeMs),
  }
}

function normalizeSummary(value: unknown): SessionSummary | undefined {
  if (!value || typeof value !== "object") return undefined
  const summary = value as Partial<SessionSummary> & { delegationDepth?: unknown }
  const delegationDepth = summary.delegationDepth ?? 0
  if (!(
    typeof summary.id === "string" &&
    typeof summary.name === "string" &&
    typeof summary.cwd === "string" &&
    isSessionLineage(summary.parentSession, delegationDepth) &&
    typeof summary.filePath === "string" &&
    Number.isSafeInteger(summary.createdAt) &&
    typeof summary.updatedAt === "number"
  )) return undefined
  return {
    id: summary.id,
    name: summary.name,
    cwd: summary.cwd,
    ...(summary.parentSession ? { parentSession: summary.parentSession } : {}),
    delegationDepth: Number(delegationDepth),
    filePath: summary.filePath,
    createdAt: Number(summary.createdAt),
    updatedAt: summary.updatedAt,
  }
}

function sameSummary(left: SessionSummary, right: SessionSummary): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.cwd === right.cwd &&
    left.parentSession === right.parentSession &&
    left.delegationDepth === right.delegationDepth &&
    left.filePath === right.filePath &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  )
}

function isSessionLineage(parentSession: unknown, delegationDepth: unknown): boolean {
  if (!Number.isSafeInteger(delegationDepth) || Number(delegationDepth) < 0) return false
  if (parentSession === undefined) return delegationDepth === 0
  return typeof parentSession === "string" &&
    parentSession.length > 0 &&
    Number(delegationDepth) >= 1
}
