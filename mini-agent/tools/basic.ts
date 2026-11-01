import type { Context } from "@deepseek-ai/cordis"
import type { Tool } from "../types.js"
import { createBashTool } from "./bash.js"
import { createEditTool } from "./edit.js"
import { createReadTool } from "./read.js"
import { createWriteTool } from "./write.js"

export function createBasicTools(ctx?: Context): Record<string, Tool> {
  const tools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(
      ctx?.jobs,
      ctx
        ? () => {
            try {
              const agent = ctx.get("agent") as {
                session: { sessionId: string }
                status: "idle" | "running"
                inject: (text: string) => void
                followup: (text: string) => void
              }
              return {
                sessionId: agent.session.sessionId,
                get status() { return agent.status },
                inject: agent.inject.bind(agent),
                followup: agent.followup.bind(agent),
              }
            } catch {
              return undefined
            }
          }
        : undefined,
    ),
  ]

  return Object.fromEntries(
    tools.map((tool) => [tool.schema.function.name, tool]),
  )
}

export const basicToolsPlugin = {
  name: "basic-tools",
  inject: ["toolRegistry", "prompt", "jobs", "sessions"],

  apply(ctx: Context) {
    ctx.effect(() => {
      const disposers = Object.values(createBasicTools(ctx)).map((tool) =>
        ctx.toolRegistry.register(tool),
      )
      const removeGuidance = ctx.prompt.section(
        "tools:guidance",
        1000,
        "Before editing a file, use read to verify the original content.\n"
          + "Use edit for exact replacements.\n"
          + "Use write only when replacing the entire file.\n"
          + "Use bash for shell commands.",
      )

      return () => {
        removeGuidance()
        for (const dispose of disposers.reverse()) dispose()
      }
    }, "basic tool registrations")
  },
}
