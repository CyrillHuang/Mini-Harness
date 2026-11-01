import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { llmPlugin } from "../llm/service.js"
import { approvalPlugin } from "../tools/approval.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import { promptPlugin } from "../prompt/plugin.js"
import { SessionPlugin } from "../session/service.js"
import { createLlmRequestError } from "../llm/errors.js"
import type { AssistantReply, LlmDelta } from "../types.js"

const context = new Context()
await context.plugin(promptPlugin)
await context.plugin(llmPlugin)
await context.plugin(approvalPlugin)
await context.plugin(toolRegistryPlugin)
await context.plugin(SessionPlugin)

const session = context.sessions.create({ cwd: process.cwd(), name: "stream-overflow" })
context.sessions.select(session.sessionId)
await session.append({
  type: "user/message",
  data: { role: "user", text: "old context" },
  surfaceOp: "append",
})
await session.append({
  type: "assistant/message",
  data: { role: "assistant", text: "old answer" },
  surfaceOp: "append",
})

let streamRequests = 0
let summaryRequests = 0
context.llm.registerAdapter("stream-overflow", {
  model: "stream-overflow-model",
  contextWindow: 1000,
  async call(): Promise<AssistantReply> {
    summaryRequests += 1
    return { role: "assistant", text: "summary text" }
  },
  async *stream(_messages, _tools, signal): AsyncGenerator<LlmDelta> {
    streamRequests += 1
    if (streamRequests === 1) {
      yield { text: "discarded partial" }
      signal?.throwIfAborted()
      throw createLlmRequestError({
        code: "CONTEXT_WINDOW_EXCEEDED",
        message: "maximum context length exceeded",
      })
    }
    yield { text: "final answer" }
    yield { finishReason: "stop" }
  },
})

const discarded: Array<{ turn: number; step: number }> = []
const detach = context.on("agent/assistant-attempt-discard", (payload) => {
  discarded.push(payload)
})

await context.plugin(AgentPlugin, {
  provider: "stream-overflow",
  compaction: {
    contextWindow: 1000,
    thresholdRatio: 1,
    retainRatio: 0,
  },
})

const result = await context.agent.run({ userText: "new question" })
detach()

if (streamRequests !== 2 || summaryRequests !== 1) {
  throw new Error(`unexpected request counts: stream=${streamRequests}, summary=${summaryRequests}`)
}
if (discarded.length !== 1 || discarded[0]?.turn !== 1 || discarded[0]?.step !== 1) {
  throw new Error(`unexpected discarded attempts: ${JSON.stringify(discarded)}`)
}
if (result.finalText !== "final answer") {
  throw new Error(`unexpected final text: ${result.finalText}`)
}
if (result.messages.some((message) =>
  message.role === "assistant" && message.text === "discarded partial",
)) {
  throw new Error("partial failed stream was persisted")
}
if (!result.messages.some((message) =>
  message.role === "assistant" && message.text === "final answer",
)) {
  throw new Error("successful retry was not persisted")
}

await context.fiber.dispose()
console.log("agent streaming overflow acceptance passed")
