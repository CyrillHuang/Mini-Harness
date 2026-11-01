import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context } from "@deepseek-ai/cordis"
import { installAgentRuntime } from "../agent/runtime.js"
import { workspacePlugin } from "../core/workspace.js"
import { llmPlugin } from "../llm/service.js"
import { SubagentService } from "../subagents/service.js"
import { GuiPlugin, type GuiState } from "../gui.js"

const home = await mkdtemp(join(tmpdir(), "mini-gui-test-"))
process.env.MINI_AGENT_HOME = home
const ctx = new Context()
try {
  await ctx.plugin(workspacePlugin)
  await ctx.plugin(llmPlugin)
  ctx.llm.registerAdapter("test", { async call() { return { role: "assistant", text: "GUI reply", finishReason: "stop" } } })
  await ctx.plugin(SubagentService)
  const runtime = await installAgentRuntime(ctx, { provider: "test" })
  await ctx.plugin(GuiPlugin)
  const url = await ctx.gui.start(0)
  async function post(path: string, data: unknown) {
    const response = await fetch(url + "/api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as GuiState
  }
  assert.equal((await fetch(url)).status, 200)
  assert.equal((await fetch(url + "/api/state", { headers: { Origin: "https://example.org" } })).status, 403)
  for (const asset of ["/markdown.js", "/vendor/marked.js", "/vendor/purify.js"]) {
    const response = await fetch(url + asset)
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type")!, /javascript/)
    assert.ok((await response.text()).length > 100)
  }
  const created = await post("create", { cwd: home, name: "GUI test" })
  assert.ok(created.session)
  assert.equal(created.session.name, "GUI test")
  await post("send", { text: "hello" })
  await ctx.agent.whenIdle()
  assert.equal(ctx.gui.getState().session?.messages.at(-1)?.text, "GUI reply")
  const approval = ctx.approval.request({ callId: "test-call", toolName: "bash", reason: "test", arguments: '{"command":"echo hello"}' })
  const pending = ctx.gui.getState().approvals[0]!
  assert.ok(pending)
  // SSE 重连直接获得完整审批快照。
  const abort = new AbortController()
  const stream = await fetch(url + "/api/events", { signal: abort.signal })
  const reader = stream.body!.getReader()
  const chunk = await reader.read()
  assert.ok(new TextDecoder().decode(chunk.value).includes(pending.id))
  abort.abort()
  await post("approval", { id: pending.id, outcome: "allowed-once" })
  assert.equal(await approval, "allowed-once")
  assert.throws(() => ctx.gui.respondApproval(pending.id, "allowed-once"))
  const cancelled = ctx.approval.request({ callId: "cancel", toolName: "bash", reason: "test" })
  await post("cancel", {})
  assert.equal(await cancelled, "cancelled")
  const gate = Promise.withResolvers<void>()
  const job = ctx.jobs.start({ kind: "test", label: "busy", run: () => gate.promise })
  assert.throws(() => ctx.gui.createSession(home))
  gate.resolve()
  await ctx.jobs.wait(job.id, 1000)
  await post("rename", { id: created.session.id, name: "Renamed" })
  const second = await post("create", { cwd: home, name: "Second" })
  await post("open", { id: created.session.id })
  assert.equal(ctx.gui.getState().session?.name, "Renamed")
  const backgroundGate = Promise.withResolvers<void>()
  const backgroundJob = ctx.jobs.start({ kind: "test", label: "background", run: () => backgroundGate.promise })
  await post("view", { id: second.session!.id })
  assert.equal(ctx.sessions.current().sessionId, created.session.id)
  assert.equal(ctx.gui.getState().session?.id, second.session!.id)
  assert.equal(ctx.gui.getState().backgroundBusy, true)
  assert.throws(() => ctx.gui.sendMessage("must not run"))
  const backgroundApproval = ctx.approval.request({ callId: "background", toolName: "bash", reason: "test" })
  assert.equal(ctx.gui.getState().approvals.length, 0)
  assert.ok(ctx.gui.getState().unreadSessions.includes(created.session.id))
  await post("view", { id: created.session.id })
  assert.equal(ctx.gui.getState().unreadSessions.length, 0)
  const request = ctx.gui.getState().approvals[0]!
  await post("approval", { id: request.id, outcome: "rejected" })
  assert.equal(await backgroundApproval, "rejected")
  backgroundGate.resolve()
  await ctx.jobs.wait(backgroundJob.id, 1000)
  await runtime.dispose()
  console.log("GUI acceptance passed: HTTP, SSE snapshot, chat, approval, cancellation, session and job guards")
} finally {
  await ctx.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
