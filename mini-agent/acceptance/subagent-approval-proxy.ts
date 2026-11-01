import { Context } from "@deepseek-ai/cordis"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  installAgentRuntime,
  type InstalledAgentRuntime,
} from "../agent/runtime.js"
import { llmPlugin, type LlmAdapter } from "../llm/service.js"
import { workspacePlugin } from "../core/workspace.js"
import { SubagentService } from "../subagents/service.js"
import type { AssistantReply } from "../types.js"

const stateDir = await mkdtemp(join(tmpdir(), "mini-agent-approval-"))
process.env.MINI_AGENT_HOME = stateDir
const context = new Context()
let runtime: InstalledAgentRuntime | undefined
try {
  await context.plugin(workspacePlugin)
  await context.plugin(llmPlugin)
  await context.plugin(SubagentService)
  const replies: AssistantReply[] = [
    {
      role: "assistant",
      text: "",
      toolCalls: [{
        id: "child-bash",
        name: "write",
        arguments: JSON.stringify({
          path: "approval-proxy-output.txt",
          content: "child-ok",
        }),
      }],
      finishReason: "tool_calls",
    },
    {
      role: "assistant",
      text: "child finished",
      finishReason: "stop",
    },
  ]
  let requestIndex = 0
  const adapter: LlmAdapter = {
    model: "subagent-approval-test",
    async call(): Promise<AssistantReply> {
      const reply = replies[requestIndex++]
      if (!reply) throw new Error("unexpected extra child model request")
      return reply
    },
  }
  context.llm.registerAdapter("subagent-approval-test", adapter)

  runtime = await installAgentRuntime(context, { provider: "subagent-approval-test" })
  const child = runtime.context
  const session = child.sessions.create({ cwd: process.cwd(), name: "approval-parent" })
  child.sessions.select(session.sessionId)

  const approvals: string[] = []
  const removeApproval = context.on("approval/request", async (request) => {
    approvals.push(request.toolName)
    return "allowed-once"
  })

  const result = await child.toolRegistry.execute({
    id: "delegate-call",
    name: "delegate",
    arguments: JSON.stringify({ prompt: "Run the approved command and report the result." }),
  }, { cwd: process.cwd() })
  removeApproval()

  const payload = JSON.parse(result.text) as {
    success: boolean
    stop_reason: string
    tool_errors: unknown[]
    text: string
  }
  if (!approvals.includes("write")) throw new Error("child approval did not reach parent handler")
  if (!payload.success || payload.stop_reason !== "completed") {
    throw new Error(`unexpected delegated success payload: ${result.text}`)
  }
  if (payload.tool_errors.length !== 0 || payload.text !== "child finished") {
    throw new Error(`unexpected delegated result payload: ${result.text}`)
  }

  requestIndex = 0
  const removeReject = context.on("approval/request", async () => "rejected")
  const rejected = await child.toolRegistry.execute({
    id: "delegate-call-rejected",
    name: "delegate",
    arguments: JSON.stringify({ prompt: "Run the command, but approval will reject it." }),
  }, { cwd: process.cwd() })
  removeReject()
  const rejectedPayload = JSON.parse(rejected.text) as {
    success: boolean
    stop_reason: string
    tool_errors: Array<{ text: string }>
  }
  if (
    rejectedPayload.success ||
    rejectedPayload.stop_reason !== "completed" ||
    rejectedPayload.tool_errors.length !== 1 ||
    !rejectedPayload.tool_errors[0]?.text.includes("approval rejected")
  ) {
    throw new Error(`delegated tool failure was not surfaced: ${rejected.text}`)
  }

  const catalogEvents = session.entries().filter((entry) => entry.type === "subagent/catalog")
  const settledEvents = session.entries().filter((entry) => entry.type === "subagent/settled")
  if (catalogEvents.length !== 2 || settledEvents.length !== 2) {
    throw new Error("one-shot child catalog lifecycle was not persisted in the parent Session")
  }
  console.log("subagent approval proxy passed", { approvals, payload })
} finally {
  await runtime?.dispose()
  await context.fiber.dispose()
  await rm(join(process.cwd(), "approval-proxy-output.txt"), { force: true })
  await rm(stateDir, { recursive: true, force: true })
}
