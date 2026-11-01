import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { Context } from "@deepseek-ai/cordis"
import type { PreStepDecision } from "./service.js"

export type AgentInstructionsOptions = {
  /** 当前 Agent 工作区；不提供时不注入任何规则。 */
  workspacePath?: string
  /** 工作区规则文件名，默认 AGENTS.md。 */
  fileName?: string
}

/** 把工作区规则作为本次 step 的模型可见上下文。 */
export const agentInstructionsPlugin = {
  name: "agent-instructions",
  inject: ["agent"],

  apply(
    ctx: Context,
    options: AgentInstructionsOptions = {},
  ) {
    let lastInjectedText: string | undefined

    ctx.on("agent/pre-step", async (payload, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (
        decision.kind === "reject"
        || payload.signal.aborted
      ) {
        return decision
      }

      const workspacePath = options.workspacePath ?? ctx.agent.session.cwd
      if (workspacePath === undefined) return decision
      const filePath = resolve(workspacePath, options.fileName ?? "AGENTS.md")

      let instructions: string
      try {
        instructions = (await readFile(filePath, "utf8")).trim()
      } catch (error) {
        if (isMissingFile(error)) return decision
        throw error
      }

      if (instructions.length === 0 || instructions === lastInjectedText) {
        return decision
      }

      lastInjectedText = instructions
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            role: "user",
            text: `Workspace instructions from ${options.fileName ?? "AGENTS.md"}:\n${instructions}`,
          },
        ],
      }
    })
  },
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT",
  )
}
