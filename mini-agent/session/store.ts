import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { LogEntry } from "./session.js"

/** 按顺序把 Session 事件追加到 JSONL 文件。 */
export class SessionStore {
  readonly filePath: string
  private directoryReady?: Promise<void>
  private pending: Promise<void> = Promise.resolve()
  private closed = false
  private closePromise?: Promise<void>

  constructor(filePath: string) {
    this.filePath = resolve(filePath)
  }

  append(entry: LogEntry): Promise<void> {
    if (this.closed) return Promise.reject(new Error("session store is closed"))

    const write = this.pending.then(async () => {
      await this.ensureDirectory()
      await appendFile(
        this.filePath,
        JSON.stringify(entry) + "\n",
        "utf8",
      )
    })
    this.pending = write
    return write
  }

  /** 读取并解析 JSONL 中的全部事件。 */
  async load(): Promise<LogEntry[]> {
    await this.pending

    let source: string
    try {
      source = await readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Session file not found: ${this.filePath}`)
      }
      throw error
    }

    const entries: LogEntry[] = []
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) continue
      try {
        entries.push(JSON.parse(line) as LogEntry)
      } catch (error) {
        throw new Error(
          `Invalid Session JSON at ${this.filePath}:${index + 1}: ${String(error)}`,
        )
      }
    }
    return entries
  }

  private ensureDirectory(): Promise<void> {
    return this.directoryReady ??= mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined)
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true
      this.closePromise = this.pending
    }
    return this.closePromise
  }
}
