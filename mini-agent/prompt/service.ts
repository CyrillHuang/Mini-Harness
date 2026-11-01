import { Service, type Context } from "@deepseek-ai/cordis"
import type { ToolSchema } from "../types.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    prompt: PromptService
  }
}

type PromptSection = {
  name: string
  order: number
  text: string
}

type PromptAssembly = {
  system: string
  tools: ToolSchema[]
}

type ToolProvider = () => readonly ToolSchema[]

export type PromptOptions = {
  persona?: string
}

export class PromptService extends Service {
  private readonly sections = new Map<string, PromptSection>()
  private readonly providers: ToolProvider[] = []

  constructor(ctx: Context, options: PromptOptions = {}) {
    super(ctx, "prompt")

    ctx.effect(() => {
      return () => {
        this.sections.clear()
        this.providers.length = 0
      }
      }, "prompt registrations")

    ctx.effect(
      () => this.section("deployment:persona", 0, options.persona ?? ""),
      "deployment persona",
    )
  }

  /** 注册一段有序 system prompt，返回移除函数。 */
  section(name: string, order: number, text: string): () => void {
    if (this.sections.has(name)) {
      throw new Error(`prompt section already registered: ${name}`)
    }

    this.sections.set(name, { name, order, text })
    return () => {
      if (this.sections.get(name)?.text === text) {
        this.sections.delete(name)
      }
    }
  }

  /** 注册动态工具 schema 来源，返回移除函数。 */
  tools(provider: ToolProvider): () => void {
    this.providers.push(provider)
    return () => {
      const index = this.providers.indexOf(provider)
      if (index >= 0) this.providers.splice(index, 1)
    }
  }

  /** 每次请求前重新生成 system prompt 和模型可见工具。 */
  assemble(): PromptAssembly {
    const system = [...this.sections.values()]
      .sort((left, right) => left.order - right.order || compareNames(left.name, right.name))
      .map((section) => section.text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n")

    const tools = this.providers
      .flatMap((provider) => provider())
      .sort((left, right) => compareNames(left.function.name, right.function.name))
      .map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: structuredClone(tool.function.parameters),
        },
      }))

    return { system, tools }
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
