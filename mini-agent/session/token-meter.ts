import type { Message } from "../types.js"

export type RequestEnvelope = Readonly<{
  provider: string
  model: string
  systemPrompt: string
  toolsSchema: string
}>

export type ProviderUsageSample = Readonly<{
  envelope: RequestEnvelope
  messages: readonly Message[]
  inputTokens: number
}>

export type TokenMeasurement = Readonly<{
  totalTokens: number
  baselineKind: "estimated" | "usage"
}>

export type TokenMeter = {
  estimate(message: Message): number
  measure(messages: readonly Message[], envelope?: RequestEnvelope): number
}

export type UsageAnchoredTokenMeter = TokenMeter & {
  measureDetails(
    messages: readonly Message[],
    envelope?: RequestEnvelope,
  ): TokenMeasurement
  recordUsage(sample: ProviderUsageSample): boolean
}

/** 创建不依赖具体模型 tokenizer 的保守估算器。 */
export function createTokenMeter(
  charsPerToken = 4,
  blockOverhead = 4,
  roleOverhead = 4,
): TokenMeter {
  validateMeterOptions(charsPerToken, blockOverhead, roleOverhead)

  return {
    estimate(message) {
      return (
        Math.ceil(codePointLength(messageContent(message)) / charsPerToken) +
        blockOverhead +
        roleOverhead
      )
    },
    measure(messages, envelope) {
      const messageTokens = messages.reduce(
        (total, message) => total + this.estimate(message),
        0,
      )
      return messageTokens + estimateEnvelope(envelope, charsPerToken)
    },
  }
}

/** 用供应商 usage 校准估算值，并继续估算后续 surface 变化。 */
export function createUsageAnchoredTokenMeter(
  charsPerToken = 4,
  blockOverhead = 4,
  roleOverhead = 4,
): UsageAnchoredTokenMeter {
  const base = createTokenMeter(charsPerToken, blockOverhead, roleOverhead)
  let anchor: {
    envelope: RequestEnvelope
    estimatedTokens: number
    providerTokens: number
  } | undefined

  const estimateRequest = (
    messages: readonly Message[],
    envelope?: RequestEnvelope,
  ): number => base.measure(messages, envelope)

  return {
    estimate: base.estimate,
    measure(messages, envelope) {
      return this.measureDetails(messages, envelope).totalTokens
    },
    measureDetails(messages, envelope) {
      const estimatedTokens = estimateRequest(messages, envelope)
      if (!anchor || !envelope || !sameEnvelope(anchor.envelope, envelope)) {
        return { totalTokens: estimatedTokens, baselineKind: "estimated" }
      }

      return {
        totalTokens: Math.max(
          0,
          anchor.providerTokens + estimatedTokens - anchor.estimatedTokens,
        ),
        baselineKind: "usage",
      }
    },
    recordUsage(sample) {
      if (!Number.isSafeInteger(sample.inputTokens) || sample.inputTokens < 0) {
        return false
      }

      const estimatedTokens = estimateRequest(sample.messages, sample.envelope)
      if (sample.inputTokens < estimatedTokens) return false

      anchor = {
        envelope: { ...sample.envelope },
        estimatedTokens,
        providerTokens: sample.inputTokens,
      }
      return true
    },
  }
}

function messageContent(message: Message): string {
  if (message.role === "assistant") {
    const calls = (message.toolCalls ?? [])
      .map((call) => `${call.id}\n${call.name}\n${call.arguments}`)
      .join("\n")
    return calls.length > 0 ? `${message.text}\n${calls}` : message.text
  }

  if (message.role === "tool") {
    return `${message.toolCallId}\n${message.isError ? "error" : "success"}\n${message.text}`
  }

  return message.text
}

function estimateEnvelope(
  envelope: RequestEnvelope | undefined,
  charsPerToken: number,
): number {
  if (!envelope) return 0
  return Math.ceil(
    codePointLength(`${envelope.systemPrompt}\n${envelope.toolsSchema}`) /
      charsPerToken,
  )
}

function sameEnvelope(left: RequestEnvelope, right: RequestEnvelope): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.systemPrompt === right.systemPrompt &&
    left.toolsSchema === right.toolsSchema
  )
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function validateMeterOptions(
  charsPerToken: number,
  blockOverhead: number,
  roleOverhead: number,
): void {
  if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw new Error("charsPerToken must be greater than zero")
  }
  if (!Number.isFinite(blockOverhead) || blockOverhead < 0) {
    throw new Error("blockOverhead must not be negative")
  }
  if (!Number.isFinite(roleOverhead) || roleOverhead < 0) {
    throw new Error("roleOverhead must not be negative")
  }
}
