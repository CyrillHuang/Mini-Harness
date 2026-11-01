import type { Message } from "../types.js"
import {
  deriveSurfaceEntries,
  validateToolCallPairs,
  type ToolPairValidation,
} from "./projection.js"
import type { LogEntry } from "./session.js"
import type { RequestEnvelope, TokenMeter } from "./token-meter.js"

export type CompactionTrigger = "pressure" | "context-overflow"

export type CompactionPolicy = Readonly<{
  contextWindow: number
  thresholdRatio: number
  retainRatio: number
}>

export type CompactionPlan = Readonly<{
  trigger: CompactionTrigger
  pressure: number
  threshold: number
  shadowedRange: { start: number; end: number }
  shadowedSeqs: number[]
  retainedSeqs: number[]
}>

/** 根据当前 surface 规划要压缩的旧消息范围，不修改日志。 */
export function planCompaction(
  entries: readonly LogEntry[],
  trigger: CompactionTrigger,
  policy: CompactionPolicy,
  meter: TokenMeter,
  envelope?: RequestEnvelope,
): CompactionPlan | null {
  validatePolicy(policy)

  const surface = deriveSurfaceEntries(entries)
  if (surface.length === 0) return null

  const pairing = validateToolCallPairs(entries)
  ensurePairingIsSafe(pairing)
  if (pairing.pendingCallSeqs.length > 0) return null

  const messages = surface.map((entry) => entry.data)
  const pressure = meter.measure(messages, envelope)
  const threshold = Math.floor(policy.contextWindow * policy.thresholdRatio)
  if (trigger === "pressure" && pressure < threshold) return null

  const retainTokens = Math.floor(policy.contextWindow * policy.retainRatio)
  let retainedTokens = 0
  let cut = surface.length

  while (cut > 0) {
    const message = surface[cut - 1]?.data
    if (!message) break

    const cost = meter.estimate(message)
    if (retainedTokens + cost > retainTokens) break

    retainedTokens += cost
    cut -= 1
  }

  // Provider 已确认溢出时，至少尝试隐藏一个最旧的完整单元；
  // 这条路径不能因为最近一条消息超过 retain 预算就直接放弃。
  if (trigger === "context-overflow" && cut === surface.length && surface.length > 1) {
    cut = surface.length - 1
  }

  // 如果切点位于工具调用和结果之间，扩展压缩范围直到结果。
  for (const pair of pairing.pairs) {
    const callIndex = surface.findIndex((entry) => entry.seq === pair.callSeq)
    const resultIndex = surface.findIndex((entry) => entry.seq === pair.resultSeq)
    if (callIndex >= 0 && resultIndex >= 0 && callIndex < cut && resultIndex >= cut) {
      cut = resultIndex + 1
    }
  }

  // 如果保留的最后一个单元是工具结果，调用和结果必须一起保留。
  // 因此把切点退到调用之前，而不是拆开这对消息。
  if (trigger === "context-overflow" && cut >= surface.length) {
    const last = surface.at(-1)
    const pair = last === undefined
      ? undefined
      : pairing.pairs.find((candidate) => candidate.resultSeq === last.seq)
    if (pair) {
      const callIndex = surface.findIndex((entry) => entry.seq === pair.callSeq)
      if (callIndex > 0) cut = callIndex
    }
  }

  if (cut === 0 || cut >= surface.length) return null

  const shadowedSeqs = surface.slice(0, cut).map((entry) => entry.seq)
  const first = shadowedSeqs[0]
  const last = shadowedSeqs.at(-1)
  if (first === undefined || last === undefined) return null

  return {
    trigger,
    pressure,
    threshold,
    shadowedRange: { start: first, end: last },
    shadowedSeqs,
    retainedSeqs: surface.slice(cut).map((entry) => entry.seq),
  }
}

/** 返回计划范围对应的消息，供后续摘要器使用。 */
export function compactionMessages(
  entries: readonly LogEntry[],
  plan: CompactionPlan,
): Message[] {
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]))
  return plan.shadowedSeqs.flatMap((seq) => {
    const entry = bySeq.get(seq)
    return entry?.data && isMessage(entry.data) ? [entry.data] : []
  })
}

function ensurePairingIsSafe(pairing: ToolPairValidation): void {
  if (pairing.unpairedResultSeqs.length > 0) {
    throw new Error(
      `Unpaired tool result seqs: ${pairing.unpairedResultSeqs.join(", ")}`,
    )
  }
}

function validatePolicy(policy: CompactionPolicy): void {
  if (!Number.isSafeInteger(policy.contextWindow) || policy.contextWindow <= 0) {
    throw new Error("contextWindow must be a positive integer")
  }
  if (!Number.isFinite(policy.thresholdRatio) || policy.thresholdRatio < 0 || policy.thresholdRatio > 1) {
    throw new Error("thresholdRatio must be between 0 and 1")
  }
  if (!Number.isFinite(policy.retainRatio) || policy.retainRatio < 0 || policy.retainRatio > 1) {
    throw new Error("retainRatio must be between 0 and 1")
  }
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
