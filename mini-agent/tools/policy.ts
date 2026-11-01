import type { Context } from "@deepseek-ai/cordis"
import type { ToolPreDecision } from "./permission.js"

/** 为需要人工确认的工具注册最小策略。 */
export const toolPolicyPlugin = {
  name: "tool-policy",

  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = [
        ctx.on("tools/pre-execute", async (execution, next): Promise<ToolPreDecision> => {
          if (execution.name === "write" || execution.name === "edit") {
            return {
              kind: "ask",
              reason: "This tool changes a file and needs your approval.",
            }
          }

          return next()
        }),
        ctx.on("tools/pre-execute", async (execution, next): Promise<ToolPreDecision> => {
          if (execution.name === "bash") {
            return {
              kind: "ask",
              reason: "This tool runs a shell command and needs your approval.",
            }
          }

          return next()
        }),
      ]

      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    }, "tool policy handlers")
  },
}
