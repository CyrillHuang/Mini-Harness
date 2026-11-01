import { Service, type Context } from "@deepseek-ai/cordis"
import type { Message } from "./types.js"
import type { ApprovalOutcome, ApprovalRequest } from "./tools/permission.js"
import { randomUUID } from "node:crypto"
import { startGuiServer } from "./gui/server.js"

/** 浏览器刷新、重连和实时更新共用的完整显示快照。 */
export type GuiState = {
  pendingText: string
  pendingUserText: string
  notice?: string
  approvals: Array<ApprovalRequest & { id: string }>
  decisions: Array<{ callId: string; outcome: ApprovalOutcome }>
  backgroundBusy: boolean
  unreadSessions: string[]
  canSwitch: boolean
  status: "idle" | "running"
  switchingSession: boolean
  session: {
    id: string
    name: string
    cwd: string | undefined
    messages: Message[]
  } | null
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    gui: GuiPlugin
  }
}

/**
 * 浏览器 GUI 的接入插件，消费现有运行时服务。
 * 管理交互状态与 HTTP/SSE，不负责创建或销毁 Agent。
 */
export class GuiPlugin extends Service {
  petConfig?: { size: number; fps: number }
  static inject = ["agent", "workspaceRegistry", "sessions", "approval", "jobs"]
  private viewedId?: string
  private unread = new Set<string>()
  private switchingSession = false
  private pendingText = ""
  private pendingUserText = ""
  private notice?: string
  private assistantSeq = 0
  private userSeq = 0
  private submitting = false
  private serverStart?: Promise<string>
  private approvals = new Map<string, { request: ApprovalRequest; resolve: (outcome: ApprovalOutcome) => void }>()

  constructor(ctx: Context) {
    super(ctx, "gui")
    ctx.effect(() => {
      const disposers = [
        ctx.on("agent/assistant-delta", (delta) => {
          this.syncDraft()
          this.pendingText += delta.text ?? ""
        }),
        ctx.on("agent/assistant-attempt-discard", () => { this.pendingText = "" }),
        ctx.on("agent/turn-end", ({ reason }) => {
          this.markUnread()
          this.pendingText = ""
          this.notice = reason.kind === "error" ? reason.error
            : reason.kind === "aborted" || reason.kind === "blocked" ? reason.reason : undefined
        }),
        ctx.on("approval/request", (request) => new Promise<ApprovalOutcome>((resolve) => {
          this.approvals.set(randomUUID(), { request, resolve })
          this.markUnread()
        })),
      ]
      return () => {
        for (const item of this.approvals.values()) item.resolve("unavailable")
        this.approvals.clear()
        for (const dispose of disposers) dispose()
      }
    }, "gui interaction")
  }

  private markUnread(): void {
    const id = this.ctx.sessions.currentOrUndefined()?.sessionId
    if (id && this.viewedId && this.viewedId !== id) this.unread.add(id)
  }

  async viewSession(id: string): Promise<GuiState> {
    await this.ctx.sessions.open(id)
    this.viewedId = id
    this.unread.delete(id)
    return this.getState()
  }

  async start(port = 4317): Promise<string> {
    return this.serverStart ??= startGuiServer(this.ctx, this, port)
  }

  async listSessions(cwd: string) {
    const workspace = this.ctx.workspaceRegistry.create(cwd)
    return this.ctx.sessions.list(workspace.path)
  }

  async renameSession(id: string, name: string): Promise<void> {
    if (!name.trim()) throw new Error("Session name must not be empty")
    await this.ctx.sessions.rename(id, name)
  }

  sendMessage(text: string): void {
    this.ctx.fiber.assertActive()
    if (this.switchingSession || this.submitting || this.ctx.agent.status !== "idle") throw new Error("Agent is busy")
    this.assertRuntimeIdle()
    if (this.viewedId && this.viewedId !== this.ctx.sessions.currentOrUndefined()?.sessionId) {
      this.ctx.sessions.select(this.viewedId)
      this.selected()
    }
    this.ctx.sessions.current()
    if (!text.trim()) throw new Error("Message must not be empty")
    this.syncDraft()
    this.pendingUserText = text
    this.notice = undefined
    this.submitting = true
    void this.ctx.agent.run({ userText: text }).catch((error: unknown) => {
      this.notice = String(error)
    }).finally(() => { this.submitting = false; this.pendingUserText = "" })
  }

  cancel(): void {
    this.ctx.agent.cancel("user stopped")
    for (const [id] of this.approvals) this.respondApproval(id, "cancelled")
  }

  respondApproval(id: string, outcome: ApprovalOutcome): void {
    if (!["allowed-once", "rejected", "cancelled"].includes(outcome)) throw new Error("Invalid approval outcome")
    const pending = this.approvals.get(id)
    if (!pending) throw new Error("Approval already resolved or unknown")
    this.approvals.delete(id)
    pending.resolve(outcome)
  }

  private syncDraft(): void {
    const entries = this.ctx.sessions.currentOrUndefined()?.entries() ?? []
    const assistant = entries.findLast((entry) => entry.type === "assistant/message")?.seq ?? 0
    const user = entries.findLast((entry) => entry.type === "user/message")?.seq ?? 0
    if (assistant !== this.assistantSeq) this.pendingText = ""
    if (user !== this.userSeq) this.pendingUserText = ""
    this.assistantSeq = assistant
    this.userSeq = user
  }

  private selected(): void {
    this.viewedId = this.ctx.sessions.current().sessionId
    this.unread.delete(this.viewedId)
    this.pendingText = this.pendingUserText = ""
    this.assistantSeq = this.userSeq = 0
    this.notice = this.ctx.sessions.current().consumeRecoveryNotice()
    this.syncDraft()
  }

  /** 创建并选择新会话；路径由工作区服务校验并规范化。 */
  createSession(cwd: string, name?: string): GuiState {
    this.assertCanSwitch()
    const workspace = this.ctx.workspaceRegistry.create(cwd)
    const session = this.ctx.sessions.create({ cwd: workspace.path, name })
    this.ctx.sessions.select(session.sessionId)
    this.selected()
    return this.getState()
  }

  /** 加载历史后再选择，失败时保留原来的当前会话。 */
  async openSession(sessionId: string): Promise<GuiState> {
    this.assertCanSwitch()
    this.switchingSession = true
    try {
      const session = await this.ctx.sessions.open(sessionId)
      // 磁盘读取期间运行时可能被其他入口唤醒，选择前再次检查。
      this.ctx.fiber.assertActive()
      this.assertRuntimeIdle()
      this.ctx.sessions.select(session.sessionId)
      this.selected()
    } finally {
      this.switchingSession = false
    }
    return this.getState()
  }

  /** 只读快照，不消费恢复提示，也不向外暴露可变的 Session 对象。 */
  getState(): GuiState {
    this.ctx.fiber.assertActive()
    const active = this.ctx.sessions.currentOrUndefined()
    const session = (this.viewedId ? this.ctx.sessions.get(this.viewedId) : active)
    const viewingActive = session?.sessionId === active?.sessionId
    const busy = this.submitting || this.ctx.agent.status !== "idle" || this.ctx.jobs.list().some(job => job.status === "running" || job.status === "stopping")
    this.syncDraft()
    return {
      backgroundBusy: busy && !viewingActive,
      unreadSessions: [...this.unread],
      pendingText: viewingActive ? this.pendingText : "",
      pendingUserText: viewingActive ? this.pendingUserText : "",
      notice: viewingActive ? this.notice : undefined,
      approvals: (viewingActive ? [...this.approvals] : []).map(([id, item]) => ({ id, ...item.request })),
      decisions: [...(session?.approvalDecisions() ?? [])].map(([callId, item]) => ({ callId, outcome: item.outcome })),
      canSwitch: !this.switchingSession && !this.submitting && this.ctx.agent.status === "idle"
        && !this.ctx.jobs.list().some((job) => job.status === "running" || job.status === "stopping"),
      status: viewingActive ? this.ctx.agent.status : "idle",
      switchingSession: this.switchingSession,
      session: session ? {
        id: session.sessionId,
        name: session.sessionName,
        cwd: session.cwd,
        messages: structuredClone(session.messages()),
      } : null,
    }
  }

  private assertCanSwitch(): void {
    this.ctx.fiber.assertActive()
    if (this.switchingSession || this.submitting) throw new Error("Session is busy")
    this.assertRuntimeIdle()
  }

  private assertRuntimeIdle(): void {
    if (this.ctx.agent.status !== "idle") {
      throw new Error("Cannot switch session while Agent is running")
    }
    if (this.ctx.jobs.list().some((job) =>
      job.status === "running" || job.status === "stopping")) {
      throw new Error("Cannot switch session while background jobs are active")
    }
  }
}
