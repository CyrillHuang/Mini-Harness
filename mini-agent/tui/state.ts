import type { TurnEndReason } from "../session/session.js"
import type { LogEntry } from "../session/session.js"
import type { LlmDelta, Message } from "../types.js"
import type { ApprovalOutcome, ApprovalRequest } from "../tools/permission.js"

/** 保存当前一次交互的显示数据，不持有终端或 Agent。 */
export class TuiState {
  messages: readonly Message[] = []
  pendingUserText = ""
  pendingText = ""
  running = false
  input = ""
  cursor = 0
  scrollOffset = 0
  reason?: TurnEndReason
  notice?: string
  approval?: ApprovalRequest
  approvalInput = ""
  focusedToolId?: string
  readonly approvalDecisions = new Map<string, {
    request: ApprovalRequest
    outcome: ApprovalOutcome
  }>()
  readonly expandedTools = new Set<string>()
  readonly startedToolIds = new Set<string>()
  private completedAssistants = 0
  private userCount = 0
  // 记录提交前已有的 user 消息数量，避免重复文本被旧消息提前匹配掉。
  private pendingUserBaseline?: number
  // 有日志时优先用 seq 判断“这一次”是否已经入账，兼容压缩后消息数量减少。
  private pendingUserBaselineSeq?: number

  /** 切换 Session 时清空上一会话的显示状态。 */
  resetSession(): void {
    this.messages = []
    this.pendingUserText = ""
    this.pendingText = ""
    this.running = false
    this.input = ""
    this.cursor = 0
    this.scrollOffset = 0
    this.reason = undefined
    this.notice = undefined
    this.approval = undefined
    this.approvalInput = ""
    this.focusedToolId = undefined
    this.approvalDecisions.clear()
    this.expandedTools.clear()
    this.startedToolIds.clear()
    this.completedAssistants = 0
    this.userCount = 0
    this.pendingUserBaseline = undefined
    this.pendingUserBaselineSeq = undefined
  }

  begin(userText: string, entries: readonly LogEntry[] = []): void {
    this.pendingUserText = userText
    this.pendingUserBaseline = this.userCount
    this.pendingUserBaselineSeq = entries
      .filter((entry) => entry.type === "user/message")
      .at(-1)?.seq
    this.beginTurn()
  }

  /** 进入一个 Agent turn；也用于后台通知唤醒的自主 turn。 */
  beginTurn(): void {
    this.pendingText = ""
    this.running = true
    this.reason = undefined
    this.approval = undefined
    this.approvalInput = ""
    this.focusedToolId = undefined
    this.completedAssistants = 0
    this.scrollOffset = 0
  }

  insert(text: string): void {
    this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor)
    this.cursor += text.length
  }

  backspace(): void {
    if (this.cursor === 0) return
    const previous = this.input.codePointAt(this.cursor - 1)
    const start = this.cursor - (previous !== undefined && previous > 0xffff ? 2 : 1)
    this.input = this.input.slice(0, start) + this.input.slice(this.cursor)
    this.cursor = start
  }

  delete(): void {
    if (this.cursor >= this.input.length) return
    const next = this.input.codePointAt(this.cursor)
    const end = this.cursor + (next !== undefined && next > 0xffff ? 2 : 1)
    this.input = this.input.slice(0, this.cursor) + this.input.slice(end)
  }

  moveCursor(offset: number): void {
    if (offset < 0) {
      if (this.cursor === 0) return
      const previous = this.input.codePointAt(this.cursor - 1)
      this.cursor -= previous !== undefined && previous > 0xffff ? 2 : 1
      return
    }
    if (this.cursor >= this.input.length) return
    const next = this.input.codePointAt(this.cursor)
    this.cursor += next !== undefined && next > 0xffff ? 2 : 1
  }

  clearInput(): string {
    const value = this.input
    this.input = ""
    this.cursor = 0
    return value
  }

  toggleTool(id: string): void {
    if (this.expandedTools.has(id)) this.expandedTools.delete(id)
    else this.expandedTools.add(id)
  }

  collapseTools(): void {
    this.expandedTools.clear()
  }

  scrollToTop(): void {
    this.scrollOffset = Number.MAX_SAFE_INTEGER
  }

  scrollToBottom(): void {
    this.scrollOffset = 0
  }

  setApproval(request: ApprovalRequest): void {
    this.approval = request
    this.approvalInput = ""
    this.scrollToBottom()
  }

  setNotice(notice: string | undefined): void {
    this.notice = notice
  }

  clearApproval(): void {
    this.approval = undefined
    this.approvalInput = ""
  }

  setApprovalInput(value: string): void {
    this.approvalInput = value
  }

  clearApprovalInput(): void {
    this.approvalInput = ""
  }

  recordApproval(outcome: ApprovalOutcome): void {
    if (!this.approval) return
    this.approvalDecisions.set(this.approval.callId, {
      request: this.approval,
      outcome,
    })
  }

  restoreApprovalDecisions(
    decisions: ReadonlyMap<string, { toolName: string; outcome: ApprovalOutcome }>,
  ): void {
    this.approvalDecisions.clear()
    for (const [callId, decision] of decisions) {
      this.approvalDecisions.set(callId, {
        request: {
          callId,
          toolName: decision.toolName,
          reason: "",
        },
        outcome: decision.outcome,
      })
    }
  }

  sync(messages: readonly Message[], entries: readonly LogEntry[] = []): void {
    const users = messages.filter((message) => message.role === "user").length
    // 压缩会把多条历史 user 合并成一条 summary，数量可能变少；
    // 因此不能只用数量判断当前输入是否已经入账。
    const lastUserText = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.text
    const latestUserEntry = [...entries]
      .reverse()
      .find((entry) => entry.type === "user/message")
    const loggedThisSubmission = latestUserEntry?.type === "user/message"
      && latestUserEntry.seq > (this.pendingUserBaselineSeq ?? -1)
      && latestUserEntry.data.text === this.pendingUserText
    // 只有确认新增了一条 user 消息后，才移除乐观显示。
    // 否则当用户连续提交相同文本时，历史消息会被误认为本次提交，
    // 导致回车后到 assistant 出现前看不到刚输入的内容。
    if (
      this.pendingUserText
      && (
        loggedThisSubmission
        || (
          this.pendingUserBaselineSeq === undefined
          && this.pendingUserBaseline !== undefined
          && users > this.pendingUserBaseline
          && lastUserText === this.pendingUserText
        )
      )
    ) {
      this.pendingUserText = ""
      this.pendingUserBaseline = undefined
      this.pendingUserBaselineSeq = undefined
    }
    this.userCount = users
    const completed = messages.filter((message) => message.role === "assistant").length
    // 完整消息入账后，替换当前流式草稿，避免重复显示。
    if (completed > this.completedAssistants) this.pendingText = ""
    this.completedAssistants = completed
    this.messages = messages
    this.startedToolIds.clear()
    for (const entry of entries) {
      if (entry.type === "tool/call") this.startedToolIds.add(entry.data.id)
    }
    const toolCalls = messages.flatMap((message) =>
      message.role === "assistant" ? message.toolCalls ?? [] : [],
    )
    // 事件可能来自异步的 tool/result，或者被子 Agent 的事件插入；
    // 没有有效焦点时始终回退到当前消息里的最后一个工具调用，
    // 保证 Ctrl+E 在空闲时也能展开 delegate 等最后一次调用。
    if (!this.focusedToolId || !toolCalls.some((call) => call.id === this.focusedToolId)) {
      this.focusedToolId = toolCalls.at(-1)?.id
    }
  }

  append(delta: LlmDelta): void {
    if (this.running) this.pendingText += delta.text ?? ""
  }

  /** 丢弃失败请求留下的流式草稿。 */
  discardPendingText(): void {
    this.pendingText = ""
  }

  finish(reason: TurnEndReason): void {
    this.running = false
    this.pendingText = ""
    this.reason = reason
  }
}
