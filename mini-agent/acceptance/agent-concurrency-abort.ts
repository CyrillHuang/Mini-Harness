import "./isolated-home.js"
import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { llmPlugin } from "../llm/service.js"
import { promptPlugin } from "../prompt/plugin.js"
import { approvalPlugin } from "../tools/approval.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import { SessionPlugin } from "../session/service.js"
import type { AssistantReply, Tool } from "../types.js"

const context = new Context()
await context.plugin(promptPlugin)
await context.plugin(llmPlugin)
await context.plugin(approvalPlugin)
await context.plugin(toolRegistryPlugin)
await context.plugin(SessionPlugin)

const session = context.sessions.create({ cwd: process.cwd(), name: "tool-concurrency-abort" })
context.sessions.select(session.sessionId)

const started: string[] = []
let releaseRunning!: () => void
const running = new Promise<void>((resolve) => {
  releaseRunning = resolve
})

function testTool(name: string, parallel: boolean): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    ...(parallel ? { isConcurrencySafe: () => true } : {}),
    async execute() {
      started.push(name)
      await running
      return name
    },
  }
}

for (const tool of [
  testTool("read-a", true),
  testTool("read-b", true),
  testTool("edit", false),
  testTool("read-c", true),
]) context.toolRegistry.register(tool)

let requestCount = 0
context.llm.registerAdapter("concurrency-abort-test", {
  async call(): Promise<AssistantReply> {
    requestCount += 1
    if (requestCount > 1) throw new Error("the model must not be called after abort")
    return {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "a", name: "read-a", arguments: "{}" },
        { id: "b", name: "read-b", arguments: "{}" },
        { id: "c", name: "edit", arguments: "{}" },
        { id: "d", name: "read-c", arguments: "{}" },
      ],
      finishReason: "tool_calls",
    }
  },
})

await context.plugin(AgentPlugin, {
  provider: "concurrency-abort-test",
  maxParallelTools: 2,
})

const resultPromise = context.agent.run({ userText: "cancel tools" })
const deadline = Date.now() + 2_000
while (started.length < 2 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1))
}
if (JSON.stringify(started) !== JSON.stringify(["read-a", "read-b"])) {
  throw new Error(`unexpected calls before cancellation: ${started.join(", ")}`)
}

context.agent.cancel("test cancellation")
releaseRunning()
const result = await resultPromise

if (result.reason.kind !== "aborted") {
  throw new Error(`expected an aborted turn, got ${result.reason.kind}`)
}
if (JSON.stringify(started) !== JSON.stringify(["read-a", "read-b"])) {
  throw new Error(`a non-dispatched tool executed after cancellation: ${started.join(", ")}`)
}

const entries = session.entries()
const resultEntries = entries.filter((entry) => entry.type === "tool/result")
const resultOrder = resultEntries.map((entry) => entry.data.toolCallId)
if (JSON.stringify(resultOrder) !== JSON.stringify(["a", "b", "c", "d"])) {
  throw new Error(`cancelled results were not committed in model order: ${resultOrder.join(", ")}`)
}
if (resultEntries.some((entry) => !entry.data.isError)) {
  throw new Error("cancelled tool calls must be recorded as errors")
}
if (!session.toolCallPairs().complete) {
  throw new Error("cancellation left an incomplete tool call/result pair")
}

await context.fiber.dispose()
console.log("agent concurrency abort acceptance passed")
