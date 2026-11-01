import { Service, type Context } from "@deepseek-ai/cordis"
import { emitSafelyFrom } from "../events.js"
import type {
  ToolCall,
  Tool,
  ToolExecution,
  ToolExecutionResult,
  ToolSchema,
} from "../types.js"
import type { ToolGuard, ToolPreDecision } from "./permission.js"
import type { ToolExecutionMode } from "./scheduler.js"

export type { ToolGuard, ToolPreDecision } from "./permission.js"

export type ToolExecutionOptions = {
  signal?: AbortSignal
  cwd?: string
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    toolRegistry: ToolRegistry
  }

  interface Events {
    "tool/call": (exec: ToolExecution) => void
    "tools/pre-execute": (
      exec: ToolExecution,
      next: () => Promise<ToolPreDecision>,
    ) => Promise<ToolPreDecision>
    "tools/execute": (
      exec: ToolExecution,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>
    "tools/post-execute": (
      exec: ToolExecution,
      result: ToolExecutionResult,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>
    "tools/result": (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
    ) => void
  }
}

export class ToolRegistry extends Service {
  private readonly tools = new Map<string, Tool>()
  private readonly guards: ToolGuard[] = []

  constructor(ctx: Context) {
    super(ctx, "toolRegistry")

    ctx.effect(
      () => ctx.prompt.tools(() => this.schemas()),
      "tool schema provider",
    )
  }

  register(tool: Tool): () => void {
    const name = tool.schema.function.name
    if (this.tools.has(name)) {
      throw new Error(`tool already registered: ${name}`)
    }

    this.tools.set(name, tool)
    return () => {
      if (this.tools.get(name) === tool) this.tools.delete(name)
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => tool.schema)
  }

  /** 只有工具对当前参数明确声明安全时才允许并发。 */
  executionMode(call: ToolCall): ToolExecutionMode {
    const classifier = this.tools.get(call.name)?.isConcurrencySafe
    if (!classifier) return "exclusive"

    try {
      const args = call.arguments ? JSON.parse(call.arguments) as unknown : {}
      return classifier(args) === true ? "parallel" : "exclusive"
    } catch {
      return "exclusive"
    }
  }

  registerGuard(guard: ToolGuard): () => void {
    this.guards.push(guard)
    return () => {
      const index = this.guards.indexOf(guard)
      if (index >= 0) this.guards.splice(index, 1)
    }
  }

  private guardReason(execution: ToolExecution): string | undefined {
    for (const guard of this.guards) {
      const reason = guard(execution)
      if (reason !== undefined) return reason
    }

    return undefined
  }

  /** 通过统一流水线执行一次工具调用。 */
  async execute(
    call: ToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<ToolExecutionResult> {
    const exec: ToolExecution = Object.freeze({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      cwd: options.cwd,
    })

    options.signal?.throwIfAborted()

    let result: ToolExecutionResult
    try {
      const decision = await this.ctx.waterfall(
        this,
        "tools/pre-execute",
        exec,
        async (): Promise<ToolPreDecision> => ({ kind: "allow" }),
      )

      if (decision.kind === "deny") {
        result = {
          text: `Tool call denied: ${decision.reason}`,
          isError: true,
        }
      } else {
        const outcome = decision.kind === "ask"
          ? await this.ctx.approval.request({
              toolName: exec.name,
              arguments: exec.arguments,
              callId: exec.id,
              reason: decision.reason,
            }, options.signal)
          : "allowed-once"
        if (outcome !== "allowed-once") {
          result = {
            text: `Tool call denied: approval ${outcome}`,
            isError: true,
          }
        } else {
          const reason = this.guardReason(exec)
          result = reason
            ? { text: `Tool call denied: ${reason}`, isError: true }
            : await this.ctx.waterfall(
                this,
                "tools/execute",
                exec,
                () => this.executeBody(exec, options),
              )
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      result = { text: String(error), isError: true }
    }

    try {
      result = await this.ctx.waterfall(
        this,
        "tools/post-execute",
        exec,
        result,
        async () => result,
      )
    } catch (error) {
      if (options.signal?.aborted) throw error
      result = { text: String(error), isError: true }
    }

    options.signal?.throwIfAborted()
    const finalResult = Object.freeze(normalizeResult(result))
    emitSafelyFrom(this.ctx, this, "tools/result", exec, finalResult)
    return finalResult
  }

  /** 执行工具本体，并把正常返回值规范化成文本结果。 */
  private async executeBody(
    exec: ToolExecution,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(exec.name)
    if (!tool) throw new Error(`Unknown tool: ${exec.name}`)

    const args = exec.arguments ? JSON.parse(exec.arguments) as unknown : {}
    options.signal?.throwIfAborted()
    const value = await tool.execute(args, options.signal, options.cwd)
    options.signal?.throwIfAborted()
    return { text: String(value), isError: false }
  }
}

function normalizeResult(result: ToolExecutionResult): ToolExecutionResult {
  return {
    text: String(result.text ?? ""),
    isError: Boolean(result.isError),
  }
}

export const toolRegistryPlugin = {
  name: "tool-registry",
  inject: ["prompt", "approval"],

  apply(ctx: Context) {
    new ToolRegistry(ctx)
  },
}
