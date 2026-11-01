import { readdir } from "node:fs/promises"
import { emitKeypressEvents } from "node:readline"
import { stdin as input } from "node:process"
import path from "node:path"
import type { TuiTheme } from "./theme.js"

/** 用键盘浏览目录并选择工作区。 */
export class WorkspacePicker {
  constructor(
    private readonly write: (text: string) => void,
    private readonly theme: TuiTheme,
    private readonly rows: () => number = () => 24,
    private readonly columns: () => number = () => 80,
  ) {}

  async pick(initialPath: string, signal: AbortSignal): Promise<string | undefined> {
    if (!input.isTTY) return initialPath

    let currentPath = path.resolve(initialPath)
    let pathBuffer = directoryPath(currentPath)
    let pathCursor = pathBuffer.length
    let entries: string[] = []
    let filter = ""
    let selected = 0
    let notice = ""

    const refresh = async (directory: string, nextFilter = "") => {
      try {
        currentPath = directory
        const children = await readdir(currentPath, { withFileTypes: true })
        entries = ["..", ...children
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((left, right) => left.localeCompare(right))]
        filter = nextFilter
        selected = Math.min(selected, Math.max(0, entries.length - 1))
        notice = ""
      } catch (error) {
        entries = [".."]
        filter = nextFilter
        selected = 0
        notice = `Cannot read directory: ${String(error)}`
      }
    }

    const previewPath = async () => {
      const raw = pathBuffer || currentPath
      const absolute = path.resolve(currentPath, raw)
      const trailingSeparator = /[\\/]$/.test(raw)
      const directory = trailingSeparator ? absolute : path.dirname(absolute)
      const nextFilter = trailingSeparator ? "" : path.basename(absolute)
      await refresh(directory, nextFilter)
      selected = 0
    }

    await refresh(currentPath)
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()

    return await new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (value: string | undefined) => {
        if (settled) return
        settled = true
        input.off("keypress", onKeypress)
        signal.removeEventListener("abort", onAbort)
        input.setRawMode(false)
        resolve(value)
      }
      const onAbort = () => finish(undefined)
      const visibleEntries = () => filter
        ? entries.filter((entry) => entry === ".." || entry.toLowerCase().includes(filter.toLowerCase()))
        : entries
      const selectedPath = () => {
        const candidate = path.resolve(currentPath, pathBuffer)
        const candidateName = path.basename(candidate)
        if (filter && entries.includes(candidateName)) return candidate
        const entry = visibleEntries()[selected]
        return entry && entry !== ".." ? path.join(currentPath, entry) : currentPath
      }
      const onKeypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) {
          finish(undefined)
          return
        }
        const list = visibleEntries()
        if (key.name === "up") selected = Math.max(0, selected - 1)
        else if (key.name === "down") selected = Math.min(list.length - 1, selected + 1)
        else if (key.name === "left") pathCursor = Math.max(0, pathCursor - 1)
        else if (key.name === "right") pathCursor = Math.min(pathBuffer.length, pathCursor + 1)
        else if (key.name === "backspace") {
          if (pathCursor > 0) {
            pathBuffer = pathBuffer.slice(0, pathCursor - 1) + pathBuffer.slice(pathCursor)
            pathCursor -= 1
            void previewPath().then(render)
            return
          }
        } else if (key.name === "delete") {
          if (pathCursor < pathBuffer.length) {
            pathBuffer = pathBuffer.slice(0, pathCursor) + pathBuffer.slice(pathCursor + 1)
            void previewPath().then(render)
            return
          }
        } else if (key.name === "return") {
          const candidate = path.resolve(currentPath, pathBuffer)
          const candidateName = path.basename(candidate)
          if (filter && entries.includes(candidateName)) {
            currentPath = candidate
            pathBuffer = directoryPath(currentPath)
            pathCursor = pathBuffer.length
            void refresh(currentPath).then(render)
            return
          }
          const entry = list[selected]
          if (entry === "..") {
            const parent = path.dirname(currentPath)
            if (parent !== currentPath) {
              currentPath = parent
              pathBuffer = directoryPath(currentPath)
              pathCursor = pathBuffer.length
              void refresh(currentPath).then(render)
              return
            }
          } else if (entry) {
            currentPath = path.join(currentPath, entry)
            pathBuffer = directoryPath(currentPath)
            pathCursor = pathBuffer.length
            void refresh(currentPath).then(render)
            return
          }
        } else if (key.name === "tab") {
          finish(selectedPath())
          return
        } else if (text && !key.ctrl && /^[\x20-\x7e]+$/.test(text)) {
          pathBuffer = pathBuffer.slice(0, pathCursor) + text + pathBuffer.slice(pathCursor)
          pathCursor += text.length
          void previewPath().then(render)
          return
        }
        render()
      }
      const render = () => {
        const list = visibleEntries()
        const height = Math.max(4, this.rows() - 8)
        const start = Math.max(0, Math.min(selected, list.length - height))
        const visible = list.slice(start, start + height)
        const lines = [
          "",
          this.theme.assistant("  Open workspace"),
          this.theme.muted("  Path: " + pathBuffer),
          "",
          ...visible.map((entry, index) => {
            const marker = start + index === selected ? ">" : " "
            const line = `  ${marker} ${entry}${entry === ".." ? "" : "/"}`
            if (start + index !== selected) return line
            const padded = fitDisplayWidth(line, this.columns())
            return process.env.NO_COLOR === undefined ? "\x1b[7m" + padded + "\x1b[0m" : padded
          }),
        ]
        if (notice) lines.push("", this.theme.error("  " + notice))
        lines.push("", this.theme.muted("  Type to filter  Up/Down move  Enter open  Tab select  Esc quit"))
        const column = Math.min(
          this.columns(),
          9 + displayWidth(pathBuffer.slice(0, pathCursor)),
        )
        this.write("\x1b[2J\x1b[H" + lines.join("\n") + `\x1b[3;${column}H`)
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

function directoryPath(value: string): string {
  if (value === path.parse(value).root || value.endsWith(path.sep)) return value
  return value + path.sep
}
