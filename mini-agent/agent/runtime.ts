import type { Context, Fiber } from "@deepseek-ai/cordis"
import { JobService } from "../jobs/service.js"
import { jobToolsPlugin } from "../jobs/plugin.js"
import { promptPlugin } from "../prompt/plugin.js"
import { SessionPlugin } from "../session/service.js"
import { approvalPlugin } from "../tools/approval.js"
import { basicToolsPlugin } from "../tools/basic.js"
import { toolPolicyPlugin } from "../tools/policy.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import { workspaceGuardPlugin } from "../tools/workspace-guard.js"
import { agentInstructionsPlugin } from "./instructions.js"
import { AgentPlugin, type AgentOptions } from "./service.js"
import { subagentToolPlugin } from "../subagents/plugin.js"

const AGENT_RUNTIME_SERVICES = [
  "agent",
  "sessions",
  "prompt",
  "toolRegistry",
  "approval",
  "jobs",
] as const

export type InstalledAgentRuntime = Readonly<{
  context: Context
  dispose: () => Promise<void>
}>

/** 为一次 Agent activation 创建相互关联、但与父级不同的服务作用域。 */
export function isolateAgentRuntime(
  parent: Context,
): Context {
  let child = parent
  for (const service of AGENT_RUNTIME_SERVICES) {
    child = child.isolate(service)
  }
  return child
}

/**
 * 安装一次 Agent 运行所需的私有能力。
 * LLM provider 和 workspace 属于上层共享能力，不在这里重复安装。
 */
export async function installAgentRuntime(
  ctx: Context,
  options: AgentOptions,
): Promise<InstalledAgentRuntime> {
  const fibers: Fiber[] = []
  const install = async (fiber: Fiber & PromiseLike<Fiber>): Promise<void> => {
    fibers.push(fiber)
    await fiber
  }

  try {
    await install(ctx.plugin(SessionPlugin))
    await install(ctx.plugin(promptPlugin))
    await install(ctx.plugin(approvalPlugin))
    await install(ctx.plugin(toolRegistryPlugin))
    await install(ctx.plugin(toolPolicyPlugin))
    await install(ctx.plugin(workspaceGuardPlugin))
    await install(ctx.plugin(JobService))
    await install(ctx.plugin(basicToolsPlugin))
    await install(ctx.plugin(AgentPlugin, options))
    await install(ctx.plugin(jobToolsPlugin))
    await install(ctx.plugin(subagentToolPlugin))
    await install(ctx.plugin(agentInstructionsPlugin))
    await install(ctx.plugin({
      name: "agent-runtime-context",
      inject: [...AGENT_RUNTIME_SERVICES, "llm"],
      apply() {},
    }))
  } catch (error) {
    try {
      await disposeFibers(fibers)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Agent runtime setup and cleanup both failed",
      )
    }
    throw error
  }

  const runtimeContext = fibers.at(-1)?.ctx
  if (!runtimeContext) throw new Error("Agent runtime context was not created")
  let disposed = false
  return {
    context: runtimeContext,
    async dispose() {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try {
        await runtimeContext.sessions.close()
      } catch (error) {
        errors.push(error)
      }
      try {
        await disposeFibers(fibers)
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to dispose Agent runtime")
      }
    },
  }
}

async function disposeFibers(fibers: readonly Fiber[]): Promise<void> {
  const errors: unknown[] = []
  for (const fiber of [...fibers].reverse()) {
    try {
      await fiber.dispose()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to dispose Agent runtime")
  }
}
