import type { TuiState } from "./state.js"
import type { TuiTheme } from "./theme.js"
import type { Message } from "../types.js"

/** 根据状态绘制内容区和固定底部操作栏。 */
export class TuiRenderer {
  private cachedContent?: {
    messages: readonly Message[]
    pendingUserText: string
    pendingText: string
    running: boolean
    reason: TuiState["reason"]
    notice: string | undefined
    approval: TuiState["approval"]
    approvalInput: string
    approvalDecisions: string
    startedToolIds: string
    focusedToolId: string | undefined
    expandedTools: string
    columns: number
    lines: string[]
  }

  constructor(
    private readonly write: (text: string) => void,
    private readonly theme: TuiTheme,
    private readonly rows: () => number = () => 24,
    private readonly columns: () => number = () => 80,
  ) {}

  reset(): void {}

  render(state: TuiState): void {
    const lines = this.contentLines(state)
    const height = Math.max(1, this.rows() - 4)
    const maxOffset = Math.max(0, lines.length - height)
    state.scrollOffset = Math.min(state.scrollOffset, maxOffset)
    const start = Math.max(0, lines.length - height - state.scrollOffset)
    const visible = lines.slice(start, start + height)
    // 内容从顶部开始，剩余空间留在内容末尾。
    while (visible.length < height) visible.push("")

    const cursor = state.input
    const separator = this.theme.muted("─".repeat(Math.max(1, this.columns())))
    const footer = state.approval
      ? [
          this.theme.warning("Ctrl+E expand  Y + Enter allow once  N + Enter reject  Esc / Ctrl+C cancel"),
          separator,
          "> " + state.approvalInput,
          separator,
        ]
      : [
          this.theme.muted("Tab/Shift+Tab tools  Ctrl+E expand  Enter submit  Up/Down scroll  Ctrl+C cancel  Esc sessions  /exit quit"),
          separator,
          "> " + cursor,
          separator,
        ]
    const row = Math.max(1, this.rows() - 1)
    // 终端列数按显示宽度计算，中文通常占两列。
    const column = Math.min(
      this.columns(),
      3 + displayWidth(state.input.slice(0, state.cursor)),
    )
    const cursorControl = state.approval
      ? `\x1b[?25h\x1b[${row};${Math.min(this.columns(), 3 + displayWidth(state.approvalInput))}H`
      : `\x1b[?25h\x1b[${row};${column}H`
    this.write("\x1b[2J\x1b[H" + [...visible, ...footer].join("\n") + cursorControl)
  }

  private contentLines(state: TuiState): string[] {
    const columns = this.columns()
    const expandedTools = [...state.expandedTools].sort().join("\0")
    const approvalDecisions = [...state.approvalDecisions]
      .map(([id, decision]) => id + ":" + decision.outcome)
      .join("\0")
    const startedToolIds = [...state.startedToolIds].sort().join("\0")
    const cached = this.cachedContent
    if (cached
      && cached.messages === state.messages
      && cached.pendingUserText === state.pendingUserText
      && cached.pendingText === state.pendingText
      && cached.running === state.running
      && cached.reason === state.reason
      && cached.notice === state.notice
      && cached.approval === state.approval
      && cached.approvalInput === state.approvalInput
      && cached.approvalDecisions === approvalDecisions
      && cached.startedToolIds === startedToolIds
      && cached.focusedToolId === state.focusedToolId
      && cached.expandedTools === expandedTools
      && cached.columns === columns) {
      return cached.lines
    }

    const lines = this.contentBlocks(state).flat()
    this.cachedContent = {
      messages: state.messages,
      pendingUserText: state.pendingUserText,
      pendingText: state.pendingText,
      running: state.running,
      reason: state.reason,
      notice: state.notice,
      approval: state.approval,
      approvalInput: state.approvalInput,
      approvalDecisions,
      startedToolIds,
      focusedToolId: state.focusedToolId,
      expandedTools,
      columns,
      lines,
    }
    return lines
  }

  private contentBlocks(state: TuiState): string[][] {
    const resultByCall = new Map(
      state.messages
        .filter((message) => message.role === "tool")
        .map((message) => [message.toolCallId, message] as const),
    )
    const blocks: string[][] = []
    let assistantBlock: string[] | undefined
    let assistantStarted = false
    for (const message of state.messages) {
      if (message.role === "user") {
        blocks.push([
          this.theme.warning("user:"),
          ...this.indent(message.text),
        ])
        assistantBlock = undefined
        assistantStarted = false
      } else if (message.role === "assistant") {
        const hasText = Boolean(message.text?.trim())
        const hasTools = Boolean(message.toolCalls?.length)
        const hasUsage = Boolean(message.usage)
        if (!assistantStarted && (hasText || hasTools || hasUsage)) {
          assistantBlock = []
          blocks.push(assistantBlock)
          if (hasText || hasTools) assistantBlock.push(this.theme.assistant("assistant:"))
        }
        if (hasText || hasTools || hasUsage) {
          assistantStarted = true
        }
        if (!assistantBlock) continue
        if (hasText) assistantBlock.push(...this.indent(message.text))
        for (const call of message.toolCalls ?? []) {
          const result = resultByCall.get(call.id)
          const decision = state.approvalDecisions.get(call.id)
          const expanded = state.expandedTools.has(call.id)
          const focused = state.focusedToolId === call.id
          const status = decision && decision.outcome !== "allowed-once"
            ? decision.outcome
            : result
              ? (result.isError ? "error" : "done")
              : state.startedToolIds.has(call.id)
                ? (state.running ? "running" : "interrupted")
                : "pending"
          const marker = (expanded ? "v" : ">") + " tool: " + call.name
          const toolLine = marker + " " + "[" + status + "]"
          if (focused) {
            const width = this.columns()
            const padding = Math.max(0, width - displayWidth(toolLine))
            const selectedLine = this.theme.tool(marker)
              + " "
              + this.theme.muted("[" + status + "]")
              + " ".repeat(padding)
            assistantBlock.push(this.theme.selected(selectedLine))
          } else {
            assistantBlock.push(this.theme.tool(marker) + " " + this.theme.muted("[" + status + "]"))
          }
          if (decision && decision.outcome !== "allowed-once") {
            const paint = decision.outcome === "rejected" || decision.outcome === "cancelled"
              ? this.theme.warning
              : this.theme.error
            assistantBlock.push(...this.indent(
              "Approval " + decision.outcome,
              "",
            ).map(paint))
          }
          if (expanded) {
            assistantBlock.push(...this.indent(call.arguments, ""))
            if (result) {
              const paint = result.isError ? this.theme.error : this.theme.result
              assistantBlock.push(...this.indent(paint(result.text), ""))
            }
          }
        }
        if (message.usage) {
          const values = [
            message.usage.inputTokens === undefined ? undefined : "input " + message.usage.inputTokens,
            message.usage.outputTokens === undefined ? undefined : "output " + message.usage.outputTokens,
            message.usage.totalTokens === undefined ? undefined : "total " + message.usage.totalTokens,
          ].filter((value): value is string => value !== undefined)
          if (values.length) assistantBlock.push(this.theme.muted("(Tokens: " + values.join(", ") + ")"))
        }
      }
    }
    if (state.pendingUserText) {
      blocks.push([
        this.theme.warning("user:"),
        ...this.indent(state.pendingUserText),
      ])
      assistantBlock = undefined
      assistantStarted = false
    }
    if (state.pendingText.trim()) {
      if (!assistantStarted) {
        assistantBlock = [this.theme.assistant("assistant:")]
        blocks.push(assistantBlock)
      }
      assistantBlock?.push(...this.indent(state.pendingText))
    }
    if (!state.running) {
      if (state.notice) blocks.push([this.theme.warning(state.notice)])
      if (state.reason?.kind === "error") blocks.push([this.theme.error("error: " + state.reason.error)])
      if (state.reason?.kind === "aborted" || state.reason?.kind === "blocked") {
        blocks.push([this.theme.warning(state.reason.kind + ": " + state.reason.reason)])
      }
      if (state.reason?.kind === "max-tokens") blocks.push([this.theme.warning("Stopped: output token limit reached.")])
    }
    if (state.approval) {
      blocks.push([
        this.theme.warning("Approval required: " + state.approval.toolName),
      ])
    }
    return blocks
  }

  private indent(text: string, prefix = ""): string[] {
    const width = Math.max(1, this.columns() - displayWidth(prefix))
    return text.split(/\r?\n/).flatMap((line) =>
      wrapLine(line, width).map((part) => prefix + part),
    )
  }
}

/** 按终端显示宽度折行，避免终端自动换行后无法滚动。 */
function wrapLine(text: string, maxWidth: number): string[] {
  const lines: string[] = []
  let current = ""
  let width = 0
  let style = ""

  for (let index = 0; index < text.length;) {
    if (text[index] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(text.slice(index))
      if (match) {
        current += match[0]
        style = match[0] === "\x1b[0m" ? "" : style + match[0]
        index += match[0].length
        continue
      }
    }

    const codePoint = text.codePointAt(index) ?? 0
    const char = String.fromCodePoint(codePoint)
    const charWidth = isCombining(codePoint) ? 0 : (isWide(codePoint) ? 2 : 1)
    if (current && width + charWidth > maxWidth) {
      lines.push(style ? current + "\x1b[0m" : current)
      current = style + char
      width = charWidth
    } else {
      current += char
      width += charWidth
    }
    index += char.length
  }

  if (current || lines.length === 0) lines.push(current)
  return lines
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (isCombining(codePoint) || codePoint === 0) continue
    width += isWide(codePoint) ? 2 : 1
  }
  return width
}

function isCombining(codePoint: number): boolean {
  return (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  )
}
