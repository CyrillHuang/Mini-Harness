import type { Context } from "@deepseek-ai/cordis"
import {
  callOpenAICompatibleModel,
  createOpenAICompatibleRequest,
  streamOpenAICompatibleModel,
  type OpenAIChunk,
} from "./openai-compatible.js"
import type { LlmDelta } from "../types.js"
import type { LlmAdapter } from "./service.js"

function createQwenAdapter(): LlmAdapter {
  const baseUrl = process.env.QWEN_BASE_URL
  const apiKey = process.env.DASHSCOPE_API_KEY
  const model = process.env.QWEN_MODEL

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "Missing QWEN_BASE_URL, DASHSCOPE_API_KEY, or QWEN_MODEL",
    )
  }

  const contextWindow = readContextWindow()
  return {
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    call(messages, tools, signal, system) {
      const request = {
        ...createOpenAICompatibleRequest(model, messages, tools, system),
        enable_thinking: false,
      }

      return callOpenAICompatibleModel({ baseUrl, apiKey }, request, signal)
    },
    async *stream(messages, tools, signal, system) {
      const request = {
        ...createOpenAICompatibleRequest(model, messages, tools, system),
        enable_thinking: false,
      }
      for await (const chunk of streamOpenAICompatibleModel(
        { baseUrl, apiKey },
        request,
        signal,
      )) {
        const delta = toQwenDelta(chunk)
        if (delta) yield delta
      }
    },
  }
}

function readContextWindow(): number | undefined {
  const value = Number(process.env.QWEN_CONTEXT_WINDOW)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function toQwenDelta(chunk: OpenAIChunk): LlmDelta | undefined {
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

export const qwenPlugin = {
  name: "qwen",
  inject: ["llm"],

  apply(ctx: Context) {
    const adapter = createQwenAdapter()
    ctx.effect(
      () => ctx.llm.registerAdapter("qwen", adapter),
      "qwen adapter registration",
    )
  },
}
