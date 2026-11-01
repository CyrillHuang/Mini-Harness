import type { AssistantReply, Message, ToolSchema } from "../types.js"
import {
  createLlmRequestError,
  isContextWindowExceededError,
  normalizeLlmError,
  type LlmErrorCode,
} from "./errors.js"
import { parseSse } from "./sse.js"

/** 保留供应商的协议字段，工具参数仍可能是不完整的片段。 */
export type OpenAIChunk = {
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
      [key: string]: unknown
    }
    finish_reason?: string | null
  }>
  usage?: Record<string, unknown> | null
  [key: string]: unknown
}

export function parseOpenAIChunk(data: string): OpenAIChunk {
  let chunk: unknown
  try {
    chunk = JSON.parse(data)
  } catch (cause) {
    throw new Error("Invalid JSON in OpenAI stream chunk", { cause })
  }

  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) {
    throw createLlmRequestError({
      message: "OpenAI stream chunk must be an object",
      code: "PROVIDER",
    })
  }
  if ("error" in chunk && chunk.error != null) {
    throw providerError(chunk.error, "OpenAI stream error")
  }
  if (!("choices" in chunk) || !Array.isArray(chunk.choices)) {
    throw createLlmRequestError({
      message: "OpenAI stream chunk must contain a choices array",
      code: "PROVIDER",
    })
  }

  // 这里只检查响应外壳，具体字段的语义由 adapter 处理。
  return chunk as OpenAIChunk
}

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        function: { name: string; arguments: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: Record<string, unknown> | null
}

export function createOpenAICompatibleRequest(
  model: string,
  messages: Message[],
  tools: ToolSchema[],
  system = "",
) {
  return {
    model,
    messages: [
      ...(system.length > 0 ? [{ role: "system" as const, content: system }] : []),
      ...messages.map(toOpenAICompatibleMessage),
    ],
    ...(tools.length > 0
      ? {
          tools,
          tool_choice: "auto" as const,
        }
      : {}),
    stream: false,
  }
}

export async function callOpenAICompatibleModel(
  connection: { baseUrl: string; apiKey: string },
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AssistantReply> {
  let response: Response
  try {
    response = await fetch(
      `${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${connection.apiKey}`,
        },
        signal,
        body: JSON.stringify(request),
      },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw createLlmRequestError({
      message: error instanceof Error ? error.message : String(error),
      code: "NETWORK",
    }, { cause: error })
  }

  if (!response.ok) {
    throw await responseError(response)
  }

  const body = (await response.json()) as OpenAICompatibleResponse
  const message = body.choices?.[0]?.message
  if (!message) {
    throw new Error("LLM returned no assistant message")
  }

  return {
    role: "assistant",
    text: message.content ?? "",
    ...(message.tool_calls?.length
      ? {
          toolCalls: message.tool_calls.map((call) => ({
            id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          })),
        }
      : {}),
    ...(body.usage ? { usage: toUsage(body.usage) } : {}),
    ...(body.choices?.[0]?.finish_reason
      ? { finishReason: body.choices[0].finish_reason }
      : {}),
  }
}

function toUsage(usage: Record<string, unknown>) {
  return {
    ...(typeof usage.prompt_tokens === "number"
      ? { inputTokens: usage.prompt_tokens }
      : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { outputTokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.total_tokens === "number"
      ? { totalTokens: usage.total_tokens }
      : {}),
  }
}

export async function* streamOpenAICompatibleModel(
  connection: { baseUrl: string; apiKey: string },
  request: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIChunk> {
  let response: Response
  try {
    response = await fetch(
      `${connection.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${connection.apiKey}`,
        },
        signal,
        body: JSON.stringify({ ...request, stream: true }),
      },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw createLlmRequestError({
      message: error instanceof Error ? error.message : String(error),
      code: "NETWORK",
    }, { cause: error })
  }

  if (!response.ok) {
    throw await responseError(response)
  }

  try {
    for await (const data of parseSse(response.body)) {
      yield parseOpenAIChunk(data)
    }
  } catch (error) {
    if (signal?.aborted) throw error
    throw normalizeLlmError(error)
  }
}

type ProviderErrorBody = {
  code?: unknown
  type?: unknown
  message?: unknown
  error?: unknown
}

function providerError(value: unknown, prefix?: string) {
  const body = asProviderErrorBody(value)
  const providerCode = stringValue(body?.code)
  const providerType = stringValue(body?.type)
  const providerMessage = stringValue(body?.message) ?? "Unknown provider error"
  const detail = [providerCode, providerType, providerMessage]
    .filter((item): item is string => item !== undefined)
    .join(" ")
  const code: LlmErrorCode = isContextWindowExceededError(detail)
    ? "CONTEXT_WINDOW_EXCEEDED"
    : "PROVIDER"
  return createLlmRequestError({
    message: prefix ? `${prefix}: ${providerMessage}` : providerMessage,
    code,
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
  })
}

async function responseError(response: Response) {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  const raw = asProviderErrorBody(body)
  const nested = raw?.error === undefined ? raw : asProviderErrorBody(raw.error)
  const providerCode = stringValue(nested?.code)
  const providerType = stringValue(nested?.type)
  const providerMessage = stringValue(nested?.message)
    ?? `LLM request failed: HTTP ${response.status}`
  const detail = [providerCode, providerType, providerMessage]
    .filter((item): item is string => item !== undefined)
    .join(" ")
  // 按 dsh 的边界处理 HTTP 错误：只有 400 且供应商明确说明上下文
  // 超限时才进入压缩；413、429 或其他状态不能仅凭相似文案触发重试。
  const code: LlmErrorCode = response.status === 401 || response.status === 403
    ? "AUTHENTICATION"
    : response.status === 400 && isContextWindowExceededError(detail)
      ? "CONTEXT_WINDOW_EXCEEDED"
      : "PROVIDER"
  return createLlmRequestError({
    message: providerMessage,
    code,
    status: response.status,
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
  })
}

function asProviderErrorBody(value: unknown): ProviderErrorBody | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ProviderErrorBody
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function toOpenAICompatibleMessage(message: Message) {
  if (message.role === "user") {
    return { role: "user", content: message.text }
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.text,
      ...(message.toolCalls
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    }
  }

  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.isError ? `Error: ${message.text}` : message.text,
  }
}
