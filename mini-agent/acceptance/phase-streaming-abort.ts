import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { llmPlugin } from "../llm/service.js"
import { promptPlugin } from "../prompt/plugin.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import type { LlmDelta } from "../types.js"

const context = new Context()
await context.plugin(promptPlugin)
await context.plugin(llmPlugin)
await context.plugin(toolRegistryPlugin)

await context.llm.registerAdapter("abort-test", {
  async *stream(_messages, _tools, signal): AsyncGenerator<LlmDelta> {
    yield { text: "partial" }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    yield { text: "unreachable" }
  },
  async call() {
    throw new Error("abort test should use stream()")
  },
})

const agent = (await context.plugin(AgentPlugin, { provider: "abort-test" }), context.agent)
const running = agent.run({ userText: "start" })
await new Promise((resolve) => setTimeout(resolve, 10))
agent.cancel("user stopped")
const result = await running

if (result.reason.kind !== "aborted" || result.reason.reason !== "user stopped") {
  throw new Error(`unexpected abort result: ${JSON.stringify(result.reason)}`)
}
if (result.messages.some((message) => message.role === "assistant")) {
  throw new Error("partial assistant message was persisted after abort")
}
const end = result.session.entries().findLast((entry) => entry.type === "turn/end")
if (end?.type !== "turn/end" || end.data.reason.kind !== "aborted") {
  throw new Error("aborted turn was not persisted")
}
if (agent.status !== "idle") {
  throw new Error(`agent did not return to idle: ${agent.status}`)
}

await context.fiber.dispose()
console.log("streaming abort acceptance passed")
