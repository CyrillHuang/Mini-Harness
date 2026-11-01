import { Service, type Context } from "@deepseek-ai/cordis"
import type { AssistantReply, LlmDelta, Message, ToolSchema } from "../types.js"

export type LlmAdapter = {
  /** 当前 adapter 对应的远端模型信息。 */
  model?: string
  contextWindow?: number
  call(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
    system?: string,
  ): Promise<AssistantReply>

  stream?(
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
    system?: string,
  ): AsyncIterable<LlmDelta>
}

export type LlmModelInfo = Readonly<{
  provider: string
  model: string
  contextWindow?: number
}>

declare module "@deepseek-ai/cordis" {
  interface Context {
    llm: LlmService
  }
}

export class LlmService extends Service {
  private readonly adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, "llm")
  }

  registerAdapter(provider: string, adapter: LlmAdapter): () => void {
    if (this.adapters.has(provider)) {
      throw new Error(`LLM provider already registered: ${provider}`)
    }

    this.adapters.set(provider, adapter)
    return () => {
      if (this.adapters.get(provider) === adapter) {
        this.adapters.delete(provider)
      }
    }
  }

  request(
    provider: string,
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
    system?: string,
  ): Promise<AssistantReply> {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new Error(`Unknown LLM provider: ${provider}`)
    }

    return adapter.call(messages, tools, signal, system)
  }

  stream(
    provider: string,
    messages: Message[],
    tools: ToolSchema[],
    signal?: AbortSignal,
    system?: string,
  ): AsyncIterable<LlmDelta> {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new Error(`Unknown LLM provider: ${provider}`)
    }
    if (!adapter.stream) {
      throw new Error(`LLM provider does not support streaming: ${provider}`)
    }

    return adapter.stream(messages, tools, signal, system)
  }

  supportsStream(provider: string): boolean {
    return this.adapters.get(provider)?.stream !== undefined
  }

  /** 返回当前 provider 的模型信息；旧 adapter 未声明时使用 provider 名。 */
  modelInfo(provider: string): LlmModelInfo {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new Error(`Unknown LLM provider: ${provider}`)
    }
    return {
      provider,
      model: adapter.model ?? provider,
      ...(adapter.contextWindow === undefined
        ? {}
        : { contextWindow: adapter.contextWindow }),
    }
  }
}

export const llmPlugin = {
  name: "llm",

  apply(ctx: Context) {
    new LlmService(ctx)
  },
}
