import type { Context } from "@deepseek-ai/cordis"
import {
  callOpenAICompatibleModel,
  createOpenAICompatibleRequest,
  streamOpenAICompatibleModel,
  type OpenAIChunk,
} from "./openai-compatible.js"
import type { LlmDelta } from "../types.js"
import type { LlmAdapter } from "./service.js"

function createDeepSeekAdapter(): LlmAdapter {
  const baseUrl = process.env.DEEPSEEK_BASE_URL
  const apiKey = process.env.DEEPSEEK_API_KEY
  const model = process.env.DEEPSEEK_MODEL

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "Missing DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY, or DEEPSEEK_MODEL",
    )
  }

  const contextWindow = readContextWindow()
  return {
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    call(messages, tools, signal, system) {
      const request = {
        ...createOpenAICompatibleRequest(model, messages, tools, system),
        thinking: { type: "disabled" as const },
      }

      return callOpenAICompatibleModel({ baseUrl, apiKey }, request, signal)
    },
    async *stream(messages, tools, signal, system) {
      const request = {
        ...createOpenAICompatibleRequest(model, messages, tools, system),
        thinking: { type: "disabled" as const },
      }
      for await (const chunk of streamOpenAICompatibleModel(
        { baseUrl, apiKey },
        request,
        signal,
      )) {
        const delta = toDeepSeekDelta(chunk)
        if (delta) yield delta
      }
    },
  }
}

function readContextWindow(): number | undefined {
  const value = Number(process.env.DEEPSEEK_CONTEXT_WINDOW)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function toDeepSeekDelta(chunk: OpenAIChunk): LlmDelta | undefined {
  const choice = chunk.choices[0]
  const delta: LlmDelta = {
    ...(choice?.delta.content != null ? { text: choice.delta.content } : {}),
    ...(choice?.finish_reason != null
      ? { finishReason: choice.finish_reason }
      : {}),
    ...(choice?.delta.tool_calls?.length
      ? {
          toolCalls: choice.delta.tool_calls.map((call) => ({
            index: call.index,
            ...(call.id ? { id: call.id } : {}),
            ...(call.function?.name ? { name: call.function.name } : {}),
            ...(call.function?.arguments
              ? { arguments: call.function.arguments }
              : {}),
          })),
        }
      : {}),
    ...(chunk.usage ? { usage: toUsage(chunk.usage) } : {}),
  }
  return Object.keys(delta).length > 0 ? delta : undefined
}

function toUsage(usage: Record<string, unknown>): LlmDelta["usage"] {
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

export const deepseekPlugin = {
  name: "deepseek",
  inject: ["llm"],

  apply(ctx: Context) {
    const adapter = createDeepSeekAdapter()
    ctx.effect(
      () => ctx.llm.registerAdapter("deepseek", adapter),
      "deepseek adapter registration",
    )
  },
}
