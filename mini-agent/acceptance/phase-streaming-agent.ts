import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { promptPlugin } from "../prompt/plugin.js"
import { llmPlugin } from "../llm/service.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import type { LlmDelta } from "../types.js"

const context = new Context()
await context.plugin(promptPlugin)
await context.plugin(llmPlugin)
await context.plugin(toolRegistryPlugin)

let requests = 0
const detachAdapter = context.llm.registerAdapter("stream-test", {
  async *stream(): AsyncGenerator<LlmDelta> {
    requests += 1
    if (requests === 1) {
      yield { text: "hello" }
      yield { text: " world" }
      yield {
        toolCalls: [{
          index: 0,
          id: "call-1",
          name: "echo",
          arguments: "{\"value\":" ,
        }],
      }
      yield { toolCalls: [{ index: 0, arguments: "\"ok\"}" }] }
      yield { finishReason: "tool_calls" }
      return
    }
    yield { text: "done" }
    yield { finishReason: "stop" }
  },
  async call() {
    throw new Error("stream test should use stream()")
  },
})

const toolDispose = context.toolRegistry.register({
  schema: {
    type: "function",
    function: {
      name: "echo",
      description: "Echo a value.",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
  },
  execute(args) {
    return (args as { value: string }).value
  },
})

await context.plugin(AgentPlugin, { provider: "stream-test" })
const agent = context.agent
const deltas: string[] = []
const finishReasons: string[] = []
const detachDeltas = context.on("agent/assistant-delta", (delta) => {
  if (delta.text) deltas.push(delta.text)
  if (delta.finishReason) finishReasons.push(delta.finishReason)
})
const result = await agent.run({ userText: "start" })

if (deltas.join("") !== "hello worlddone") {
  throw new Error(`unexpected streamed text: ${deltas.join("")}`)
}
if (result.finalText !== "done") {
  throw new Error(`unexpected final text: ${result.finalText}`)
}
if (finishReasons.join(",") !== "tool_calls,stop") {
  throw new Error(`finish reasons were not preserved: ${finishReasons.join(",")}`)
}
const assistantMessages = result.messages.filter((message) => message.role === "assistant")
if (assistantMessages.length !== 2 || assistantMessages[0]?.toolCalls?.[0]?.arguments !== "{\"value\":\"ok\"}") {
  throw new Error("streamed tool call was not reconstructed")
}
if (!result.messages.some((message) => message.role === "tool")) {
  throw new Error("streamed tool call did not enter the tool pipeline")
}

detachDeltas()
toolDispose()
detachAdapter()
await context.fiber.dispose()
console.log("streaming agent acceptance passed")
