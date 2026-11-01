import type { Message } from "../types.js"
import type { LogEntry } from "./session.js"

export type ToolCallPair = Readonly<{
  callSeq: number
  resultSeq: number
  toolCallId: string
}>

export type ToolPairValidation = Readonly<{
  pairs: ToolCallPair[]
  pendingCallSeqs: number[]
  unpairedResultSeqs: number[]
  complete: boolean
}>

export function deriveMessages(entries: readonly LogEntry[]): Message[] {
  return deriveSurfaceEntries(entries).map((entry) => entry.data)
}

/** 返回按当前 surface 顺序可见的消息事件及其日志序号。 */
export function deriveSurfaceEntries(entries: readonly LogEntry[]): SurfaceEntry[] {
  return replaySurfaceEntries(entries)
}

/** 校验当前 surface 上工具调用和结果是否完整配对。 */
export function validateToolCallPairs(
  entries: readonly LogEntry[],
): ToolPairValidation {
  const calls = new Map<string, number>()
  const results = new Map<string, number>()

  for (const entry of deriveSurfaceEntries(entries)) {
    if (entry.data.role === "assistant") {
      for (const call of entry.data.toolCalls ?? []) {
        if (calls.has(call.id)) {
          throw new Error(`Duplicate tool call id: ${call.id}`)
        }
        calls.set(call.id, entry.seq)
      }
      continue
    }

    if (entry.data.role === "tool") {
      if (results.has(entry.data.toolCallId)) {
        throw new Error(`Duplicate tool result id: ${entry.data.toolCallId}`)
      }
      results.set(entry.data.toolCallId, entry.seq)
    }
  }

  const pairs: ToolCallPair[] = []
  const pendingCallSeqs: number[] = []
  for (const [toolCallId, callSeq] of calls) {
    const resultSeq = results.get(toolCallId)
    if (resultSeq === undefined || resultSeq < callSeq) {
      pendingCallSeqs.push(callSeq)
      continue
    }
    pairs.push({ callSeq, resultSeq, toolCallId })
  }

  const unpairedResultSeqs: number[] = []
  for (const [toolCallId, resultSeq] of results) {
    const callSeq = calls.get(toolCallId)
    if (callSeq === undefined || resultSeq < callSeq) {
      unpairedResultSeqs.push(resultSeq)
    }
  }

  return {
    pairs,
    pendingCallSeqs,
    unpairedResultSeqs,
    complete: pendingCallSeqs.length === 0 && unpairedResultSeqs.length === 0,
  }
}

export type SurfaceEntry = LogEntry & { data: Message }

function replaySurfaceEntries(entries: readonly LogEntry[]): SurfaceEntry[] {
  const visibleSeqs: number[] = []
  const entriesBySeq = new Map<number, LogEntry>()

  for (const entry of entries) {
    entriesBySeq.set(entry.seq, entry)
    if (entry.surfaceOp === undefined) continue

    if (entry.surfaceOp === "append") {
      visibleSeqs.push(entry.seq)
      continue
    }

    const startIndex = visibleSeqs.indexOf(entry.surfaceOp.start)
    const endIndex = visibleSeqs.indexOf(entry.surfaceOp.end)
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
      throw new Error("Invalid surface replacement range")
    }

    visibleSeqs.splice(startIndex, endIndex - startIndex + 1, entry.seq)
  }

  return visibleSeqs.map((seq) => {
    const entry = entriesBySeq.get(seq)
    if (!entry || !isMessage(entry.data)) {
      throw new Error("Surface event does not contain a valid message")
    }
    return entry as SurfaceEntry
  })
}

/** 返回消息列表中最后一条 assistant 文本。 */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "assistant") return message.text
  }

  return ""
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false

  const candidate = value as Record<string, unknown>
  if (candidate.role === "user" || candidate.role === "assistant") {
    return typeof candidate.text === "string"
  }

  return (
    candidate.role === "tool" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.isError === "boolean"
  )
}
