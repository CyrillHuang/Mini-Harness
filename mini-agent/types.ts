export type ToolCall = {
  id: string
  name: string
  arguments: string
}

/** 进入工具流水线的冻结调用身份。 */
export type ToolExecution = Readonly<{
  id: string
  name: string
  arguments: string
  cwd?: string
}>

/** 工具流水线统一返回的结果。 */
export type ToolExecutionResult = {
  text: string
  isError: boolean
}

export type UserMessage = {
  role: "user"
  text: string
}

export type ToolResult = {
  role: "tool"
  toolCallId: string
  text: string
  isError: boolean
}

export type AssistantReply = {
  role: "assistant"
  text: string
  toolCalls?: ToolCall[]
  usage?: LlmUsage
  finishReason?: string
}

export type LlmUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/** LLM 流式输出的一小段增量。 */
export type LlmDelta = {
  text?: string
  toolCalls?: Array<{
    index: number
    id?: string
    name?: string
    arguments?: string
  }>
  finishReason?: string
  usage?: LlmUsage
}

export type Message =
  | UserMessage
  | AssistantReply
  | ToolResult

export type ToolSchema = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type Tool = {
  schema: ToolSchema
  /** 只有明确返回 true 时，后续调度器才允许并发执行。 */
  isConcurrencySafe?: (args: unknown) => boolean
  execute(
    args: unknown,
    signal?: AbortSignal,
    cwd?: string,
  ): unknown | Promise<unknown>
}
