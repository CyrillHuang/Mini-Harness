/** LLM 请求失败的稳定分类，业务逻辑只依赖 code。 */
export type LlmErrorCode =
  | "CONTEXT_WINDOW_EXCEEDED"
  | "AUTHENTICATION"
  | "QUOTA"
  | "NETWORK"
  | "PROVIDER"
  | "UNKNOWN"

export type LlmFailure = Readonly<{
  message: string
  code: LlmErrorCode
  status?: number
  providerCode?: string
  providerType?: string
}>

export class LlmRequestError extends Error {
  readonly code: LlmErrorCode
  readonly failure: LlmFailure

  constructor(failure: LlmFailure, options?: ErrorOptions) {
    super(failure.message, options)
    this.name = "LlmRequestError"
    this.code = failure.code
    this.failure = Object.freeze({ ...failure })
  }
}

/** 只把明确指向模型上下文容量的描述识别为溢出。 */
export function isContextWindowExceededError(detail: string): boolean {
  return /(?:context[ _-](?:length|window)|maximum[ _-]context[ _-](?:length|window))[ _-](?:exceed(?:ed|s)?|overflow(?:ed)?|limit[ _-]exceeded)/i.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || /(?:prompt|input|request|messages?)\s+(?:is\s+)?too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?(?:model(?:'s)?\s+)?context(?:\s+window)?/i.test(detail)
    || /(?:input|prompt|request|messages?).{0,40}(?:exceed(?:ed|s)?|overflows?|is\s+larger\s+than).{0,40}(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?/i.test(detail)
}

export function createLlmRequestError(
  failure: LlmFailure,
  options?: ErrorOptions,
): LlmRequestError {
  return new LlmRequestError(failure, options)
}

/** 将未知异常收敛为统一错误，保留已有的结构化错误。 */
export function normalizeLlmError(value: unknown): LlmRequestError {
  if (value instanceof LlmRequestError) return value
  const message = value instanceof Error && value.message.length > 0
    ? value.message
    : String(value)
  return new LlmRequestError({ message, code: "UNKNOWN" }, { cause: value })
}

export function isLlmRequestError(value: unknown): value is LlmRequestError {
  return value instanceof LlmRequestError
}
