import { Context } from "@deepseek-ai/cordis"
import {
  installAgentRuntime,
  type InstalledAgentRuntime,
} from "./agent/runtime.js"
import { deepseekPlugin } from "./llm/deepseek.js"
import { llmPlugin } from "./llm/service.js"
import { qwenPlugin } from "./llm/qwen.js"
import { workspacePlugin } from "./core/workspace.js"
import { TuiPlugin } from "./tui.js"
import { GuiPlugin } from "./gui.js"
import { PetPlugin } from "./pet.js"
import { SubagentService } from "./subagents/service.js"

const provider = process.env.MINI_AGENT_PROVIDER ?? "qwen"
const providerPlugin = provider === "qwen"
  ? qwenPlugin
  : provider === "deepseek"
    ? deepseekPlugin
    : undefined

if (!providerPlugin) {
  throw new Error(`Unknown MINI_AGENT_PROVIDER: ${provider}`)
}

/** 组合应用插件，并负责整个 Context 的生命周期。 */
const context = new Context()
let agentRuntime: InstalledAgentRuntime | undefined

try {
  await context.plugin(workspacePlugin)
  await context.plugin(llmPlugin)
  await context.plugin(providerPlugin)
  await context.plugin(SubagentService)
  agentRuntime = await installAgentRuntime(context, {
    provider,
  })
  if (process.argv.includes("--gui")) {
    await context.plugin(GuiPlugin)
    if (!process.argv.includes("--no-pet")) await context.plugin(PetPlugin)
    const url = await context.gui.start(Number(process.env.MINI_AGENT_GUI_PORT ?? 4317))
    console.log(`Mini-Harness GUI: ${url}`)
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop)
        process.off("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
    context.gui.cancel()
    await context.agent.whenIdle()
  } else {
    await context.plugin(TuiPlugin)
    await context.tui.start()
  }
} finally {
  try {
    if (agentRuntime) await context.sessions.close()
  } finally {
    await agentRuntime?.dispose()
    await context.fiber.dispose()
  }
}
