import type { Context } from "@deepseek-ai/cordis"
import type { Tool } from "../types.js"

type DelegateArguments = {
  prompt?: unknown
  name?: unknown
}

function createDelegateTool(ctx: Context): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "delegate",
        description: "Delegate a focused task to a one-shot child agent and wait for its result. "
          + "If tool_errors is non-empty, treat the task as not fully completed.",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "A self-contained task for the child agent.",
            },
            name: {
              type: "string",
              description: "Optional human-readable child session name.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    },
    async execute(rawArgs, signal) {
      const args = rawArgs as DelegateArguments
      if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
        throw new Error("delegate prompt must be a non-empty string")
      }
      if (args.name !== undefined && typeof args.name !== "string") {
        throw new Error("delegate name must be a string")
      }
      signal?.throwIfAborted()

      const run = await ctx.subagents.start(ctx, {
        prompt: args.prompt,
        ...(args.name === undefined ? {} : { name: args.name }),
        signal,
      })
      const result = await run.result
      signal?.throwIfAborted()
      return JSON.stringify({
        child_session_id: result.childSessionId,
        stop_reason: result.stopReason,
        success: result.stopReason === "completed" && result.toolErrors.length === 0,
        tool_errors: result.toolErrors,
        text: result.finalText,
        ...(result.error ? { error: result.error } : {}),
      })
    },
  }
}

/** 注册模型可见的 one-shot 委派工具。 */
export const subagentToolPlugin = {
  name: "subagent-tool",
  inject: ["subagents", "toolRegistry", "prompt", "agent"],

  apply(ctx: Context) {
    ctx.effect(() => {
      const disposeTool = ctx.toolRegistry.register(createDelegateTool(ctx))
      const removeGuidance = ctx.prompt.section(
        "tools:subagents",
        1020,
        "Use delegate for a focused, self-contained subtask. "
          + "The child returns one final result; do not delegate the same task repeatedly. "
          + "Check success and tool_errors before claiming that the delegated task succeeded.",
      )
      return () => {
        removeGuidance()
        disposeTool()
      }
    }, "subagent tool registration")
  },
}
