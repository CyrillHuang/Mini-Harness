import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { llmPlugin } from "../llm/service.js"
import { promptPlugin } from "../prompt/plugin.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import type { LlmDelta } from "../types.js"

async function run(deltas: LlmDelta[]) {
  const context = new Context()
  await context.plugin(promptPlugin)
  await context.plugin(llmPlugin)
  await context.plugin(toolRegistryPlugin)
  context.llm.registerAdapter("test", {
    async *stream(): AsyncGenerator<LlmDelta> {
      for (const delta of deltas) yield delta
    },
    async call() {
      throw new Error("finish reason test should use stream()")
    },
  })
  await context.plugin(AgentPlugin, { provider: "test" })
  const errors: unknown[] = []
  const removeError = context.on("agent/error", ({ error }) => errors.push(error))
  const result = await context.agent.run({ userText: "test" })
  removeError()
  await context.fiber.dispose()
  return { result, errors }
}

const length = await run([{ text: "partial", finishReason: "length" }])
if (length.result.reason.kind !== "max-tokens") {
  throw new Error("length was not mapped to max-tokens")
}

const filtered = await run([{ finishReason: "content_filter" }])
if (filtered.result.reason.kind !== "error" || filtered.errors.length !== 1) {
  throw new Error("content_filter was not reported as an agent error")
}

const missingTools = await run([{ finishReason: "tool_calls" }])
if (missingTools.result.reason.kind !== "error" || missingTools.errors.length !== 1) {
  throw new Error("missing tool calls were not reported as a protocol error")
}

console.log("streaming finish reason acceptance passed")
