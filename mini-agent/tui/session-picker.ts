import { emitKeypressEvents } from "node:readline"
import { stdin as input } from "node:process"
import type { SessionSummary } from "../session/catalog.js"
import type { TuiTheme } from "./theme.js"

export type SessionChoice =
  | { kind: "new"; name?: string }
  | { kind: "open"; id: string }
  | { kind: "rename"; id: string; name: string }

/** 用键盘选择已有 Session 或创建新的 Session。 */
export class SessionPicker {
  constructor(
    private readonly write: (text: string) => void,
    private readonly theme: TuiTheme,
    private readonly rows: () => number = () => 24,
    private readonly columns: () => number = () => 80,
  ) {}

  async pick(
    workspacePath: string,
    summaries: readonly SessionSummary[],
    signal: AbortSignal,
  ): Promise<SessionChoice | undefined> {
    if (!input.isTTY) return { kind: "new" }

    const items: Array<SessionChoice & { label: string; name?: string }> = [
      { kind: "new", label: "New session" },
      ...summaries.map((summary) => ({
        kind: "open" as const,
        id: summary.id,
        name: summary.name,
        label: `${summary.name}  [${summary.id.slice(-8)}]`,
      })),
    ]
    let selected = 0
    let mode: "list" | "name" = "list"
    let nameMode: "new" | "rename" = "new"
    let renameId: string | undefined
    let nameBuffer = ""
    let nameCursor = 0

    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()

    return await new Promise<SessionChoice | undefined>((resolve) => {
      let settled = false
      const finish = (value: SessionChoice | undefined) => {
        if (settled) return
        settled = true
        input.off("keypress", onKeypress)
        signal.removeEventListener("abort", onAbort)
        input.setRawMode(false)
        resolve(value)
      }
      const onAbort = () => finish(undefined)
      const onKeypress = (
        text: string | undefined,
        key: { name?: string; ctrl?: boolean; meta?: boolean },
      ) => {
        if (mode === "name") {
          if (key.name === "escape" || (key.ctrl && key.name === "c")) {
            mode = "list"
            render()
            return
          }
          if (key.name === "return") {
            const name = nameBuffer.trim() || "Untitled session"
            if (nameMode === "rename" && renameId) {
              finish({ kind: "rename", id: renameId, name })
            } else {
              finish({ kind: "new", name })
            }
            return
          }
          if (key.name === "left") nameCursor = moveCursorLeft(nameBuffer, nameCursor)
          else if (key.name === "right") nameCursor = moveCursorRight(nameBuffer, nameCursor)
          else if (key.name === "backspace") {
            if (nameCursor > 0) {
              const start = moveCursorLeft(nameBuffer, nameCursor)
              nameBuffer = nameBuffer.slice(0, start) + nameBuffer.slice(nameCursor)
              nameCursor = start
            }
          } else if (key.name === "delete") {
            if (nameCursor < nameBuffer.length) {
              const end = moveCursorRight(nameBuffer, nameCursor)
              nameBuffer = nameBuffer.slice(0, nameCursor) + nameBuffer.slice(end)
            }
          } else if (text && !key.ctrl && !key.meta && isTextInput(text)) {
            nameBuffer = nameBuffer.slice(0, nameCursor) + text + nameBuffer.slice(nameCursor)
            nameCursor += text.length
          }
          render()
          return
        }

        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          finish(undefined)
          return
        }
        if (key.name === "up") selected = Math.max(0, selected - 1)
        else if (key.name === "down") selected = Math.min(items.length - 1, selected + 1)
        else if (key.name === "r") {
          const item = items[selected]
          if (item?.kind === "open") {
            mode = "name"
            nameMode = "rename"
            renameId = item.id
            nameBuffer = item.name ?? ""
            nameCursor = nameBuffer.length
          }
        }
        else if (key.name === "return") {
          const item = items[selected]
          if (item) {
            if (item.kind === "new") {
              mode = "name"
              nameMode = "new"
              renameId = undefined
              nameBuffer = ""
              nameCursor = 0
            } else {
              finish({ kind: "open", id: item.id })
              return
            }
          }
        }
        render()
      }
      const render = () => {
        if (mode === "name") {
          const lines = [
            "",
            this.theme.assistant(nameMode === "rename" ? "  Rename session" : "  New session"),
            this.theme.muted("  Workspace: " + workspacePath),
            "",
            this.theme.muted("  Session name"),
            "  > " + nameBuffer,
            "",
            this.theme.muted(
              nameMode === "rename"
                ? "  Type a name  Enter save  Esc back"
                : "  Type a name  Enter create  Esc back",
            ),
          ]
          const column = Math.min(
            this.columns(),
            5 + displayWidth(nameBuffer.slice(0, nameCursor)),
          )
          this.write(
            "\x1b[2J\x1b[H" + lines.join("\n")
            + `\x1b[?25h\x1b[6;${column}H`,
          )
          return
        }

        const height = Math.max(4, this.rows() - 8)
        const start = Math.max(0, Math.min(selected, items.length - height))
        const visible = items.slice(start, start + height)
        const lines = [
          "",
          this.theme.assistant("  Select session"),
          this.theme.muted("  Workspace: " + workspacePath),
          "",
          ...visible.map((item, index) => {
            const marker = start + index === selected ? ">" : " "
            const line = `  ${marker} ${item.label}`
            if (start + index !== selected) return line
            const padded = fitDisplayWidth(line, this.columns())
            return process.env.NO_COLOR === undefined
              ? "\x1b[7m" + padded + "\x1b[0m"
              : padded
          }),
          "",
          this.theme.muted("  Up/Down move  Enter select  R rename  Esc back"),
        ]
        this.write("\x1b[2J\x1b[H" + lines.join("\n") + "\x1b[?25l")
      }
      input.on("keypress", onKeypress)
      signal.addEventListener("abort", onAbort, { once: true })
      render()
    })
  }
}

function displayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    width += codePoint >= 0x1100 ? 2 : 1
  }
  return width
}

function fitDisplayWidth(text: string, width: number): string {
  const target = Math.max(0, width)
  let result = ""
  let used = 0
  for (const character of text) {
    const characterWidth = displayWidth(character)
    if (used + characterWidth > target) break
    result += character
    used += characterWidth
  }
  return result + " ".repeat(target - used)
}

function isTextInput(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint < 0x20 || codePoint === 0x7f) return false
  }
  return true
}

function moveCursorLeft(text: string, cursor: number): number {
  if (cursor === 0) return 0
  const codePoint = text.codePointAt(cursor - 1)
  return cursor - (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
}

function moveCursorRight(text: string, cursor: number): number {
  if (cursor >= text.length) return text.length
  const codePoint = text.codePointAt(cursor)
  return cursor + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1)
}
