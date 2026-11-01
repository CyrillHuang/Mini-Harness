import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { approvalPlugin } from "../tools/approval.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import { llmPlugin } from "../llm/service.js"
import {
  createLlmRequestError,
} from "../llm/errors.js"
import { promptPlugin } from "../prompt/plugin.js"
import { SessionPlugin } from "../session/service.js"
import type { AssistantReply } from "../types.js"

type Scenario = "recovered" | "still-overflowing"

async function runScenario(scenario: Scenario) {
  const context = new Context()
  await context.plugin(promptPlugin)
  await context.plugin(llmPlugin)
  await context.plugin(approvalPlugin)
  await context.plugin(toolRegistryPlugin)
  await context.plugin(SessionPlugin)

  const session = context.sessions.create({
    cwd: process.cwd(),
    name: `context-overflow-${scenario}`,
  })
  context.sessions.select(session.sessionId)
  await session.append({
    type: "user/message",
    data: { role: "user", text: "old question" },
    surfaceOp: "append",
  })
  await session.append({
    type: "assistant/message",
    data: { role: "assistant", text: "old answer" },
    surfaceOp: "append",
  })

  let requests = 0
  let summaryMessages: readonly { role: string; text?: string }[] | undefined
  context.llm.registerAdapter("overflow-test", {
    model: "overflow-test-model",
    contextWindow: 1000,
    async call(messages, _tools, _signal, system): Promise<AssistantReply> {
      requests += 1
      if (system?.includes("You summarize conversation history")) {
        summaryMessages = messages as readonly { role: string; text?: string }[]
      }
      if (requests === 1 || (scenario === "still-overflowing" && requests === 3)) {
        throw createLlmRequestError({
          code: "CONTEXT_WINDOW_EXCEEDED",
          message: "maximum context length exceeded",
        })
      }
      if (requests === 2) {
        return { role: "assistant", text: "summary" }
      }
      return { role: "assistant", text: "recovered answer" }
    },
  })

  const errors: unknown[] = []
  const detach = context.on("agent/request-error", async ({ failure }, next) => {
    errors.push(failure)
    return next()
  })

  await context.plugin(AgentPlugin, {
    provider: "overflow-test",
    compaction: {
      contextWindow: 1000,
      thresholdRatio: 1,
      retainRatio: 0,
    },
  })

  const result = await context.agent.run({ userText: "new question" })
  detach()

  const compactionEvents = session.entries().filter((entry) =>
    entry.type === "compaction/start"
    || entry.type === "compaction/summary"
    || entry.type === "compaction/end",
  )
  const replacementEvents = session.entries().filter((entry) =>
    entry.surfaceOp !== undefined && entry.surfaceOp !== "append",
  )

  await context.fiber.dispose()
  return { requests, errors, result, compactionEvents, replacementEvents, summaryMessages }
}

const recovered = await runScenario("recovered")
if (recovered.requests !== 3) {
  throw new Error(`expected summary plus one retry, got ${recovered.requests} requests`)
}
if (recovered.errors.length !== 1) {
  throw new Error(`expected one request-error event, got ${recovered.errors.length}`)
}
if (recovered.result.reason.kind !== "completed") {
  throw new Error(`recovered turn ended as ${recovered.result.reason.kind}`)
}
if (recovered.result.finalText !== "recovered answer") {
  throw new Error(`unexpected recovered answer: ${recovered.result.finalText}`)
}
if (recovered.compactionEvents.length !== 3 || recovered.replacementEvents.length !== 1) {
  throw new Error("successful recovery did not persist a complete compaction replacement")
}
if (
  recovered.summaryMessages?.length !== 1 ||
  recovered.summaryMessages[0]?.role !== "user" ||
  !recovered.summaryMessages[0]?.text?.includes("[assistant]")
) {
  throw new Error("summary request was not isolated as a plain transcript")
}

const failed = await runScenario("still-overflowing")
if (failed.requests !== 3) {
  throw new Error(`expected exactly one retry after compaction, got ${failed.requests} requests`)
}
if (failed.result.reason.kind !== "error") {
  throw new Error(`persistent overflow ended as ${failed.result.reason.kind}`)
}
if (failed.replacementEvents.length !== 1) {
  throw new Error("persistent overflow should retain the first compaction replacement")
}
const finalError = failed.result.reason.kind === "error" ? failed.result.reason.error : ""
if (!finalError.includes("maximum context length exceeded")) {
  throw new Error(`original overflow error was not preserved: ${finalError}`)
}

console.log("agent context overflow acceptance passed")
