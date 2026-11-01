import { emitKeypressEvents } from "node:readline"
import { homedir } from "node:os"
import { stdin as input, stdout as output } from "node:process"
import { Service, type Context } from "@deepseek-ai/cordis"
import { TuiRenderer } from "./tui/renderer.js"
import { TuiState } from "./tui/state.js"
import { createTuiTheme } from "./tui/theme.js"
import { SessionPicker } from "./tui/session-picker.js"
import { WorkspacePicker } from "./tui/workspace-picker.js"
import type { ApprovalOutcome, ApprovalRequest } from "./tools/permission.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    tui: TuiPlugin
  }
}

function isMouseSequence(text: string | undefined, sequence?: string): boolean {
  if (sequence?.includes("\x1b[<")) return true
  if (!text) return false
  if (text.includes("\x1b[<")) return true
  // 鼠标报告被 readline 拆开后只剩数字和分号，末尾不一定有 M/m。
  return /^[0-9;Mm]+$/.test(text) && text.includes(";") && text.length >= 5
}

/** 负责终端输入、Agent 调用和结果展示。 */
export class TuiPlugin extends Service {
  static inject = ["agent", "workspaceRegistry", "sessions"]

  private running?: Promise<void>
  private interactive = false
  private pendingApproval?: {
    resolve: (outcome: ApprovalOutcome) => void
  }
  private readonly state = new TuiState()
  private readonly theme = createTuiTheme(Boolean(output.isTTY) && process.env.NO_COLOR === undefined)
  private readonly renderer = new TuiRenderer(
    (text) => { output.write(text) },
    this.theme,
    () => Math.max(6, output.rows || 24),
    () => Math.max(20, output.columns || 80),
  )
  private readonly workspacePicker = new WorkspacePicker(
    (text) => { output.write(text) },
    this.theme,
    () => Math.max(12, output.rows || 24),
    () => Math.max(20, output.columns || 80),
  )
  private readonly sessionPicker = new SessionPicker(
    (text) => { output.write(text) },
    this.theme,
    () => Math.max(12, output.rows || 24),
    () => Math.max(20, output.columns || 80),
  )

  constructor(ctx: Context) {
    super(ctx, "tui")
    ctx.effect(() => {
      const disposers = [
        ctx.on("agent/turn-start", () => {
          if (!this.interactive) return
          this.syncState()
          this.state.beginTurn()
          this.renderer.render(this.state)
        }),
        ctx.on("agent/turn-end", ({ reason }) => {
          if (!this.interactive) return
          this.syncState()
          this.state.finish(reason)
          this.renderer.render(this.state)
        }),
        ctx.on("agent/assistant-delta", (delta) => {
          if (!this.state.running) return
          this.syncState()
          this.state.append(delta)
          this.renderer.render(this.state)
        }),
        ctx.on("agent/assistant-attempt-discard", () => {
          if (!this.state.running) return
          this.state.discardPendingText()
          this.renderer.render(this.state)
        }),
        ctx.on("tool/call", (execution) => {
          if (!this.state.running) return
          const messages = this.currentMessages()
          if (!messages.some((message) => message.role === "assistant"
            && message.toolCalls?.some((tool) => tool.id === execution.id))) return
          this.syncState()
          this.state.focusedToolId = execution.id
          this.renderer.render(this.state)
        }),
        ctx.on("tools/result", (call, result) => {
          if (!this.state.running) return
          const messages = this.currentMessages()
          if (!messages.some((message) => message.role === "assistant"
            && message.toolCalls?.some((tool) => tool.id === call.id))) return
          // 此事件早于 tool/result 入账，先展示已返回的工具结果。
          this.syncState([...messages, {
            role: "tool",
            toolCallId: call.id,
            text: result.text,
            isError: result.isError,
          }])
          this.renderer.render(this.state)
        }),
        ctx.on("approval/request", (request, next) =>
          this.handleApprovalRequest(request, next)),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, "tui event handlers")
  }

  /** 启动交互循环；重复调用会等待同一个循环。 */
  start(): Promise<void> {
    this.ctx.fiber.assertActive()
    this.running ??= this.runLoop().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async runLoop(): Promise<void> {
    const stop = new AbortController()
    const alternateScreen = Boolean(output.isTTY)
    // 清理上一次异常退出可能遗留的鼠标报告模式。
    if (output.isTTY) output.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l")
    if (alternateScreen) output.write("\x1b[?1049h\x1b[2J\x1b[H")
    this.ctx.effect(
      () => () => {
        stop.abort()
      },
      "tui input",
    )

    try {
      while (!stop.signal.aborted) {
        const workspacePath = await this.workspacePicker.pick(homedir(), stop.signal)
        if (workspacePath === undefined) return
        const workspace = this.ctx.workspaceRegistry.create(workspacePath)

        while (!stop.signal.aborted) {
          const summaries = await this.ctx.sessions.list(workspace.path)
          const choice = await this.sessionPicker.pick(workspace.path, summaries, stop.signal)
          if (!choice) break
          if (choice.kind === "open") {
            await this.ctx.sessions.restore(choice.id)
          } else if (choice.kind === "rename") {
            await this.ctx.sessions.rename(choice.id, choice.name)
            await this.ctx.sessions.restore(choice.id)
          } else {
            const session = this.ctx.sessions.create({
              cwd: workspace.path,
              name: choice.name ?? process.env.MINI_AGENT_SESSION_NAME,
            })
            this.ctx.sessions.select(session.sessionId)
          }
          const recoveryNotice = this.ctx.agent.session.consumeRecoveryNotice()
          this.state.resetSession()
          this.state.setNotice(recoveryNotice)
          const action = await this.runInteractive(stop)
          await this.ctx.sessions.list(workspace.path)
          if (action === "back") continue
          return
        }
      }
    } finally {
      if (input.isTTY) input.setRawMode(false)
      input.pause()
      if (output.isTTY) output.write("\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l")
      if (alternateScreen) output.write("\x1b[?1049l")
    }
  }

  private async runInteractive(stop: AbortController): Promise<"exit" | "back"> {
    if (!input.isTTY) throw new Error("TUI requires an interactive terminal")
    const interactionStop = new AbortController()
    const abortInteraction = () => interactionStop.abort()
    stop.signal.addEventListener("abort", abortInteraction, { once: true })
    let action: "exit" | "back" = "exit"
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    this.interactive = true
    this.syncState()
    this.state.restoreApprovalDecisions(this.ctx.agent.session.approvalDecisions())
    this.renderer.render(this.state)

    const onKeypress = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
    ) => {
      if (isMouseSequence(text, key.sequence)) return
      if (key.ctrl && key.name === "c") {
        if (this.pendingApproval) {
          this.resolveApproval("cancelled")
          if (this.state.running) this.ctx.agent.cancel("approval cancelled")
          return
        }
        if (this.state.running) this.ctx.agent.cancel("user stopped")
        return
      }
      if (this.pendingApproval) {
        if (key.name === "escape") {
          this.resolveApproval("cancelled")
        } else if (key.name === "return" && !key.shift) {
          if (this.state.approvalInput === "y") this.resolveApproval("allowed-once")
          else if (this.state.approvalInput === "n") this.resolveApproval("rejected")
        } else if (key.ctrl && key.name === "e") {
          this.toggleApprovalTool()
        } else if (key.name === "backspace" || key.name === "delete") {
          this.state.clearApprovalInput()
          this.renderer.render(this.state)
        } else if (text?.toLowerCase() === "y" || text?.toLowerCase() === "n") {
          this.state.setApprovalInput(text.toLowerCase())
          this.renderer.render(this.state)
        }
        return
      }
      if (key.ctrl && key.name === "e") this.toggleFocusedTool()
      else if (key.name === "tab") this.moveToolFocus(key.shift ? -1 : 1)
      else if (key.name === "pageup") this.state.scrollOffset += 5
      else if (key.name === "pagedown") this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 5)
      else if (key.name === "home") this.state.scrollToTop()
      else if (key.name === "end") this.state.scrollToBottom()
      else if (key.name === "up") this.state.scrollOffset += 1
      else if (key.name === "down") this.state.scrollOffset = Math.max(0, this.state.scrollOffset - 1)
      else if (key.name === "left") this.state.moveCursor(-1)
      else if (key.name === "right") this.state.moveCursor(1)
      else if (key.name === "backspace") this.state.backspace()
      else if (key.name === "delete") this.state.delete()
      else if (key.name === "return") {
        if (!this.state.running) {
          const command = this.state.clearInput().trim()
          if (command === "/exit") interactionStop.abort()
          else if (command && !this.handleViewCommand(command)) void this.submit(command)
        }
      } else if (key.name === "escape" && !this.state.running) {
        action = "back"
        interactionStop.abort()
      } else if (text && !key.ctrl) {
        this.state.insert(text)
      }
      this.renderer.render(this.state)
    }

    input.on("keypress", onKeypress)
    const onResize = () => this.renderer.render(this.state)
    output.on("resize", onResize)
    try {
      await new Promise<void>((resolve) => {
        if (interactionStop.signal.aborted) resolve()
        else interactionStop.signal.addEventListener("abort", () => resolve(), { once: true })
      })
    } finally {
      if (this.pendingApproval) this.resolveApproval("cancelled")
      this.interactive = false
      input.off("keypress", onKeypress)
      output.off("resize", onResize)
      stop.signal.removeEventListener("abort", abortInteraction)
    }
    return action
  }

  private async handleApprovalRequest(
    request: ApprovalRequest,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.interactive || this.pendingApproval) return next()

    return new Promise<ApprovalOutcome>((resolve) => {
      this.pendingApproval = { resolve }
      this.state.setApproval(request)
      this.renderer.render(this.state)
    })
  }

  private resolveApproval(outcome: ApprovalOutcome): void {
    const pending = this.pendingApproval
    if (!pending) return
    this.state.recordApproval(outcome)
    this.pendingApproval = undefined
    this.state.clearApproval()
    pending.resolve(outcome)
    this.renderer.render(this.state)
  }

  private async submit(userText: string): Promise<void> {
    this.state.begin(userText, this.ctx.agent.session.entries())
    this.renderer.render(this.state)
    try {
      const result = await this.ctx.agent.run({ userText })
      this.syncState()
      this.state.finish(result.reason)
    } catch (error) {
      this.state.finish({ kind: "error", error: String(error) })
    }
    this.renderer.render(this.state)
  }

  private currentMessages() {
    return this.ctx.agent.session.messages()
  }

  private syncState(messages = this.currentMessages()): void {
    this.state.sync(messages, this.ctx.agent.session.entries())
  }

  private moveToolFocus(direction: 1 | -1): void {
    const calls = this.toolCalls()
    if (calls.length === 0) return
    const current = calls.findIndex((call) => call.id === this.state.focusedToolId)
    const index = current < 0
      ? (direction > 0 ? 0 : calls.length - 1)
      : (current + direction + calls.length) % calls.length
    this.state.focusedToolId = calls[index]?.id
    this.renderer.render(this.state)
  }

  private toggleFocusedTool(): void {
    const calls = this.toolCalls()
    const call = calls.find((item) => item.id === this.state.focusedToolId)
      ?? calls.at(-1)
    if (!call) return
    this.state.focusedToolId = call.id
    this.state.toggleTool(call.id)
    this.renderer.render(this.state)
  }

  /** 审批中的 call 可能属于隔离的子 Agent；此时回退到外层 delegate。 */
  private toggleApprovalTool(): void {
    const approvalId = this.state.approval?.callId
    const calls = this.toolCalls()
    const call = calls.find((item) => item.id === approvalId)
      ?? calls.find((item) => item.id === this.state.focusedToolId)
      ?? calls.at(-1)
    if (!call) return
    this.state.focusedToolId = call.id
    this.state.toggleTool(call.id)
    this.renderer.render(this.state)
  }

  private toolCalls() {
    return this.state.messages.flatMap((message) =>
      message.role === "assistant" ? message.toolCalls ?? [] : [],
    )
  }

  private handleViewCommand(command: string): boolean {
    if (command === "/collapse") {
      this.state.collapseTools()
      this.renderer.render(this.state)
      return true
    }
    const match = /^\/expand\s+(\d+)$/.exec(command)
    if (!match) return false
    const index = Number(match[1]) - 1
    const calls = this.state.messages.flatMap((message) =>
      message.role === "assistant" ? message.toolCalls ?? [] : [],
    )
    const call = calls[index]
    if (!call) {
      console.error("Unknown tool number.")
      return true
    }
    this.state.toggleTool(call.id)
    this.renderer.render(this.state)
    return true
  }

}
