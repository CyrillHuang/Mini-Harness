import { randomUUID } from "node:crypto"
import { Service, type Context } from "@deepseek-ai/cordis"
import { Session } from "./session.js"
import { SessionStore } from "./store.js"
import { sessionPath } from "./storage-path.js"
import { SessionCatalog, type SessionSummary } from "./catalog.js"
import type { SessionLineage } from "../subagents/types.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessions: SessionPlugin
  }
}

export type SessionCreateOptions = {
  cwd: string
  name?: string
  id?: string
  lineage?: SessionLineage
}

export type SessionListOptions = {
  includeSubagents?: boolean
}

type ManagedSession = {
  session: Session
  store: SessionStore
}

/** 管理当前进程中的 Session 和对应存储。 */
export class SessionPlugin extends Service {
  readonly catalog = new SessionCatalog()
  private readonly records = new Map<string, ManagedSession>()
  private currentSession?: Session
  private closed = false
  private closePromise?: Promise<void>

  constructor(ctx: Context) {
    super(ctx, "sessions")

    ctx.effect(
      () => () => {
        void this.close()
      },
      "session stores",
    )
    ctx.effect(() => {
      const dispose = ctx.on("approval/decided", async (request, outcome) => {
        const session = this.currentSession
        if (!session) return
        await session.append({
          type: "approval/decided",
          data: {
            callId: request.callId,
            toolName: request.toolName,
            outcome,
          },
        })
      })
      return dispose
    }, "approval decisions")
  }

  /** 创建一个绑定到工作区的新 Session。 */
  create(options: SessionCreateOptions): Session {
    this.assertOpen()

    const id = options.id ?? `session-${randomUUID()}`
    if (this.records.has(id)) {
      throw new Error(`Session already exists: ${id}`)
    }

    const store = new SessionStore(sessionPath(id))
    const session = new Session(store, {
      sessionId: id,
      sessionName: options.name?.trim() || "Untitled session",
      lineage: options.lineage,
    })
    session.bindCwd(options.cwd)
    this.records.set(id, { session, store })
    return session
  }

  /** 选择当前 Agent 要使用的 Session。 */
  select(sessionId: string): Session {
    this.assertOpen()

    const managed = this.records.get(sessionId)
    if (!managed) throw new Error(`Unknown session: ${sessionId}`)
    this.currentSession = managed.session
    return managed.session
  }

  /** 打开一个已经持久化的 Session。 */
  async open(sessionId: string): Promise<Session> {
    this.assertOpen()

    const existing = this.records.get(sessionId)
    if (existing) return existing.session

    const summary = await this.catalog.get(sessionId)
    if (!summary) throw new Error(`Unknown session: ${sessionId}`)

    const store = new SessionStore(summary.filePath)
    const session = Session.restore(store, await store.load())
    await session.recoverInterruptedTurn()
    this.records.set(sessionId, { session, store })
    return session
  }

  /** 打开并选择一个已经持久化的 Session。 */
  async restore(sessionId: string): Promise<Session> {
    const session = await this.open(sessionId)
    this.currentSession = session
    return session
  }

  /** 查询某个根 Session 产生的内部子 Agent。 */
  async listSubagents(parentSessionId: string): Promise<SessionSummary[]> {
    this.assertOpen()
    const parent = await this.open(parentSessionId)
    const cataloged = new Set<string>()
    for (const entry of parent.entries()) {
      if (entry.type === "subagent/catalog") cataloged.add(entry.data.childSessionId)
    }
    const children = await this.catalog.listChildren(parentSessionId)
    return children.filter((child) => cataloged.has(child.id))
  }

  /** 按父 Session 校验后读取一个内部 child 的完整历史。 */
  async openSubagent(parentSessionId: string, childSessionId: string): Promise<Session> {
    this.assertOpen()

    const existing = this.records.get(childSessionId)
    if (existing) {
      if (existing.session.parentSession !== parentSessionId) {
        throw new Error(`Subagent is not owned by Session: ${childSessionId}`)
      }
      return existing.session
    }

    const parent = await this.open(parentSessionId)
    const cataloged = parent.entries().some((entry) => {
      if (entry.type !== "subagent/catalog") return false
      return entry.data.childSessionId === childSessionId
    })
    if (!cataloged) throw new Error(`Child Session is not cataloged: ${childSessionId}`)

    const summary = await this.catalog.getChild(parentSessionId, childSessionId)
    if (!summary) throw new Error(`Unknown child Session: ${childSessionId}`)

    const store = new SessionStore(summary.filePath)
    const session = Session.restore(store, await store.load())
    if (session.parentSession !== parentSessionId) {
      await store.close()
      throw new Error(`Subagent lineage mismatch: ${childSessionId}`)
    }
    this.records.set(childSessionId, { session, store })
    return session
  }

  /** 修改 Session 名称并追加持久化事件。 */
  async rename(sessionId: string, name: string): Promise<void> {
    this.assertOpen()
    const session = await this.open(sessionId)
    await session.rename(name)
  }

  /** 返回当前选中的 Session。 */
  currentOrUndefined(): Session | undefined {
    this.assertOpen()
    return this.currentSession
  }

  /** 返回当前选中的 Session；未选择时抛错。 */
  current(): Session {
    this.assertOpen()
    if (!this.currentSession) {
      throw new Error("No current session selected")
    }
    return this.currentSession
  }

  /** 获取当前进程中已经登记的 Session。 */
  get(sessionId: string): Session | undefined {
    return this.records.get(sessionId)?.session
  }

  /** 列出内存和磁盘中属于指定 workspace 的 Session。 */
  async list(cwd?: string, options: SessionListOptions = {}): Promise<SessionSummary[]> {
    this.assertOpen()

    for (const { session, store } of this.records.values()) {
      const entries = session.entries()
      const first = entries[0]
      const last = entries[entries.length - 1]
      if (
        !first ||
        first.type !== "session/start" ||
        !last ||
        session.parentSession !== undefined
      ) continue
      await this.catalog.register({
        id: session.sessionId,
        name: session.sessionName,
        cwd: session.cwd ?? "",
        ...session.lineage(),
        filePath: store.filePath,
        createdAt: first.time,
        updatedAt: last.time,
      })
    }

    const disk = await this.catalog.list(cwd)
    const memory = [...this.records.values()]
      .map(({ session, store }) => ({
        id: session.sessionId,
        name: session.sessionName,
        cwd: session.cwd ?? "",
        ...session.lineage(),
        filePath: store.filePath,
        createdAt: session.entries()[0]?.time ?? 0,
        updatedAt: session.entries().at(-1)?.time ?? 0,
      }))
      .filter((summary) => cwd === undefined || summary.cwd === cwd)

    const merged = new Map(disk.map((summary) => [summary.id, summary]))
    for (const summary of memory) merged.set(summary.id, summary)
    return [...merged.values()]
      .filter((summary) => options.includeSubagents || summary.parentSession === undefined)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      )
  }

  /** 关闭所有 SessionStore，并阻止新的 Session 创建。 */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = Promise.all(
      [...this.records.values()].map(({ store }) => store.close()),
    ).then(() => {
      this.currentSession = undefined
      this.records.clear()
    })
    return this.closePromise
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Session service is closed")
  }
}
