import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { agentStateDir } from "./storage-path.js"
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
  archived?: boolean
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
  private archiveFile = join(agentStateDir(), "archived-sessions.json")
  private archived: Record<string, number> = {}
  private deleting = new Set<string>()
  private deletionFile = join(agentStateDir(), "pending-session-deletion.json")
  private currentSession?: Session
  private closed = false
  private closePromise?: Promise<void>

  constructor(ctx: Context) {
    super(ctx, "sessions")
    if (existsSync(this.archiveFile)) this.archived = JSON.parse(readFileSync(this.archiveFile, "utf8"))
    if (existsSync(this.deletionFile)) {
      const ids: string[] = JSON.parse(readFileSync(this.deletionFile, "utf8"))
      this.finishDeletion(ids)
    }

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

    if (this.isArchived(sessionId)) throw new Error("Restore archived session before using it")
    const managed = this.records.get(sessionId)
    if (!managed) throw new Error(`Unknown session: ${sessionId}`)
    this.currentSession = managed.session
    return managed.session
  }

  /** 打开一个已经持久化的 Session。 */
  async open(sessionId: string): Promise<Session> {
    this.assertOpen()

    if (this.deleting.has(sessionId)) throw new Error("Session is being deleted")
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
    return this.select(session.sessionId)
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
    if (this.isArchived(sessionId)) throw new Error("Archived session is read-only")
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
      if (this.deleting.has(session.sessionId)) continue
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
      .filter(summary => !this.deleting.has(summary.id))
      .filter(summary => this.isArchived(summary.id) === !!options.archived)
      .map(summary => ({ ...summary, archivedAt: this.archived[summary.id] }))
      .filter((summary) => options.includeSubagents || summary.parentSession === undefined)
      .sort((left, right) =>
        right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      )
  }

  private finishDeletion(ids: string[]): void {
    const paths = ids.map(id => sessionPath(id)) // Validate all IDs before touching files.
    for (const path of paths) {
      try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    const next = { ...this.archived }
    for (const id of ids) { delete next[id]; this.records.delete(id) }
    writeFileSync(this.archiveFile + ".tmp", JSON.stringify(next))
    renameSync(this.archiveFile + ".tmp", this.archiveFile)
    this.archived = next
    unlinkSync(this.deletionFile)
  }

  async deleteArchived(id: string): Promise<void> {
    this.assertOpen()
    if (!this.isArchived(id)) throw new Error("Only archived sessions can be deleted")
    if (this.deleting.size) throw new Error("A deletion is already in progress; restart to retry interrupted cleanup")
    const ids = new Set<string>([id])
    for (const parent of ids) {
      for (const child of await this.catalog.listChildren(parent)) ids.add(child.id)
      for (const { session } of this.records.values()) if (session.parentSession === parent) ids.add(session.sessionId)
    }
    for (const key of ids) sessionPath(key)
    this.deleting = ids
    try {
      for (const key of ids) await this.records.get(key)?.store.close()
      mkdirSync(agentStateDir(), { recursive: true })
      writeFileSync(this.deletionFile + ".tmp", JSON.stringify([...ids]))
      renameSync(this.deletionFile + ".tmp", this.deletionFile)
      this.finishDeletion([...ids])
      if (this.currentSession && ids.has(this.currentSession.sessionId)) this.currentSession = undefined
      await this.catalog.list() // Reconcile removed files with the persisted index.
    } finally { if (!existsSync(this.deletionFile)) this.deleting.clear() }
  }

  isArchived(id: string): boolean { return Object.hasOwn(this.archived, id) }

  setArchived(id: string, archived: boolean): void {
    this.assertOpen()
    if (this.deleting.has(id)) throw new Error("Session is being deleted")
    if (!this.records.has(id)) throw new Error("Unknown session")
    const next = { ...this.archived }
    if (archived) next[id] = Date.now()
    else delete next[id]
    mkdirSync(agentStateDir(), { recursive: true })
    writeFileSync(this.archiveFile + ".tmp", JSON.stringify(next))
    renameSync(this.archiveFile + ".tmp", this.archiveFile)
    this.archived = next
    if (archived && this.currentSession?.sessionId === id) this.currentSession = undefined
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
