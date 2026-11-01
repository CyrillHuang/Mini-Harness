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

const session = context.sessions.create({ cwd: process.cwd(), name: "tool-concurrency" })
context.sessions.select(session.sessionId)

const starts: string[] = []
const finishes: string[] = []
let active = 0
let maximumActive = 0

function createTestTool(name: string, delay: number, parallel: boolean): Tool {
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
      starts.push(name)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      finishes.push(name)
      return name
    },
  }
}

for (const tool of [
  createTestTool("read-a", 40, true),
  createTestTool("read-b", 5, true),
  createTestTool("edit", 5, false),
  createTestTool("read-c", 5, true),
]) context.toolRegistry.register(tool)

let requestCount = 0
context.llm.registerAdapter("concurrency-test", {
  async call(): Promise<AssistantReply> {
    requestCount += 1
    if (requestCount === 1) {
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
    }
    return { role: "assistant", text: "done", finishReason: "stop" }
  },
})

await context.plugin(AgentPlugin, {
  provider: "concurrency-test",
  maxParallelTools: 2,
})
const result = await context.agent.run({ userText: "run tools" })

if (maximumActive !== 2) {
  throw new Error(`expected max two active tools, got ${maximumActive}`)
}
if (JSON.stringify(starts) !== JSON.stringify(["read-a", "read-b", "edit", "read-c"])) {
  throw new Error(`unexpected dispatch order: ${starts.join(", ")}`)
}
if (JSON.stringify(finishes) !== JSON.stringify(["read-b", "read-a", "edit", "read-c"])) {
  throw new Error(`expected the first parallel group to finish out of order: ${finishes.join(", ")}`)
}

const entries = session.entries()
const resultOrder = entries
  .filter((entry) => entry.type === "tool/result")
  .map((entry) => entry.data.toolCallId)
if (JSON.stringify(resultOrder) !== JSON.stringify(["a", "b", "c", "d"])) {
  throw new Error(`tool results were not committed in model order: ${resultOrder.join(", ")}`)
}
if (result.reason.kind !== "completed") {
  throw new Error(`unexpected turn result: ${result.reason.kind}`)
}

await context.fiber.dispose()
console.log("agent concurrency acceptance passed")
