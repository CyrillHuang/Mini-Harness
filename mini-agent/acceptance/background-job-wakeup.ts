import "./isolated-home.js"
import { Context } from "@deepseek-ai/cordis"
import { AgentPlugin } from "../agent/service.js"
import { JobService } from "../jobs/service.js"
import { jobToolsPlugin } from "../jobs/plugin.js"
import type { JobOwner } from "../jobs/types.js"
import { llmPlugin } from "../llm/service.js"
import { promptPlugin } from "../prompt/plugin.js"
import { SessionPlugin } from "../session/service.js"
import { approvalPlugin } from "../tools/approval.js"
import { toolRegistryPlugin } from "../tools/registry.js"
import type { AssistantReply } from "../types.js"

const context = new Context()
await context.plugin(SessionPlugin)
await context.plugin(llmPlugin)
await context.plugin(promptPlugin)
await context.plugin(approvalPlugin)
await context.plugin(toolRegistryPlugin)
await context.plugin(JobService, { maxActivePerOwner: 2 })

const session = context.sessions.create({ cwd: process.cwd(), name: "job-wakeup" })
context.sessions.select(session.sessionId)

let requests = 0
context.llm.registerAdapter("job-wakeup-test", {
  async call(): Promise<AssistantReply> {
    requests += 1
    return {
      role: "assistant",
      text: requests === 1 ? "initial turn finished" : "background completion handled",
      finishReason: "stop",
    }
  },
})

await context.plugin(AgentPlugin, { provider: "job-wakeup-test" })
await context.plugin(jobToolsPlugin, { maxConsecutiveWakeups: 2 })

const starts: number[] = []
const ends: number[] = []
context.on("agent/turn-start", ({ turn }) => starts.push(turn))
context.on("agent/turn-end", ({ turn }) => ends.push(turn))

await context.agent.run({ userText: "start" })

const completed = context.jobs.start({
  kind: "lifecycle",
  label: "completed",
  ownerSession: "lifecycle-owner",
  run({ write }) {
    write("completed output\n")
  },
})
const completedResult = await context.jobs.wait(completed.id, 1_000, "lifecycle-owner")
if (completedResult.status !== "completed") {
  throw new Error(`expected completed job, got ${completedResult.status}`)
}
if (context.jobs.read(completed.id, "lifecycle-owner").text !== "completed output\n") {
  throw new Error("completed job output was not retained")
}

const failed = context.jobs.start({
  kind: "lifecycle",
  label: "failed",
  ownerSession: "lifecycle-owner",
  run() {
    throw new Error("expected failure")
  },
})
const failedResult = await context.jobs.wait(failed.id, 1_000, "lifecycle-owner")
if (failedResult.status !== "failed") {
  throw new Error(`expected failed job, got ${failedResult.status}`)
}

const killed = context.jobs.start({
  kind: "lifecycle",
  label: "killed",
  ownerSession: "lifecycle-owner",
  run({ signal }) {
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  },
})
if (context.jobs.kill(killed.id, "lifecycle-owner") !== "requested") {
  throw new Error("running job should accept cancellation")
}
if (context.jobs.get(killed.id, "lifecycle-owner").status !== "stopping") {
  throw new Error("kill should enter stopping before runner settlement")
}
const killedResult = await context.jobs.wait(killed.id, 1_000, "lifecycle-owner")
if (killedResult.status !== "killed") {
  throw new Error(`expected killed job, got ${killedResult.status}`)
}

const firstGate = Promise.withResolvers<void>()
const secondGate = Promise.withResolvers<void>()
const limitedA = context.jobs.start({
  kind: "limited",
  label: "first",
  ownerSession: "limited-owner",
  run: () => firstGate.promise,
})
const limitedB = context.jobs.start({
  kind: "limited",
  label: "second",
  ownerSession: "limited-owner",
  run: () => secondGate.promise,
})
let limitRejected = false
try {
  context.jobs.start({
    kind: "limited",
    label: "third",
    ownerSession: "limited-owner",
    run() {},
  })
} catch (error) {
  limitRejected = String(error).includes("Background job limit reached")
}
if (!limitRejected) throw new Error("per-session active job limit was not enforced")
firstGate.resolve()
secondGate.resolve()
await Promise.all([
  context.jobs.wait(limitedA.id, 1_000, "limited-owner"),
  context.jobs.wait(limitedB.id, 1_000, "limited-owner"),
])

const idleFollowups: string[] = []
const idleInjections: string[] = []
const idleOwner: JobOwner = {
  sessionId: session.sessionId,
  status: "idle",
  followup: (text) => idleFollowups.push(text),
  inject: (text) => idleInjections.push(text),
}
for (let index = 1; index <= 3; index += 1) {
  const idleJob = context.jobs.start({
    kind: "notify",
    label: `idle-${index}`,
    owner: idleOwner,
    run() {},
  })
  await context.jobs.wait(idleJob.id, 1_000, session.sessionId)
}
if (idleFollowups.length !== 2 || idleInjections.length !== 1) {
  throw new Error("idle notification delivery did not honor the wakeup budget")
}

await context.agent.run({ userText: "reset wakeup budget" })
const afterReset = context.jobs.start({
  kind: "notify",
  label: "idle-after-user",
  owner: idleOwner,
  run() {},
})
await context.jobs.wait(afterReset.id, 1_000, session.sessionId)
if (Number(idleFollowups.length) !== 3) {
  throw new Error("real user input did not reset the wakeup budget")
}

const busyInjections: string[] = []
const busyFollowups: string[] = []
const busyOwner: JobOwner = {
  sessionId: session.sessionId,
  status: "running",
  inject: (text) => busyInjections.push(text),
  followup: (text) => busyFollowups.push(text),
}
const busyJob = context.jobs.start({
  kind: "notify",
  label: "busy",
  owner: busyOwner,
  run() {},
})
await context.jobs.wait(busyJob.id, 1_000, session.sessionId)
if (busyInjections.length !== 1 || busyFollowups.length !== 0) {
  throw new Error("busy owner should receive an injected notification")
}

const owner = {
  sessionId: session.sessionId,
  get status() {
    return context.agent.status
  },
  inject: (text: string) => context.agent.inject(text),
  followup: (text: string) => context.agent.followup(text),
}

const job = context.jobs.start({
  kind: "test",
  label: "short task",
  owner,
  async run({ write }) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    write("finished\n")
  },
})

await context.jobs.wait(job.id, 1_000, session.sessionId)
await context.agent.whenIdle()

if (JSON.stringify(starts) !== JSON.stringify([1, 2, 3])) {
  throw new Error(`expected three turn-start events, got ${starts.join(", ")}`)
}
if (JSON.stringify(ends) !== JSON.stringify([1, 2, 3])) {
  throw new Error(`expected three turn-end events, got ${ends.join(", ")}`)
}
if (requests !== 3) {
  throw new Error(`expected autonomous completion turn, got ${requests} model requests`)
}
if (!session.messages().some((message) =>
  message.role === "user" && message.text.includes(`Background job ${job.id}`))) {
  throw new Error("background completion notice was not committed")
}
if (session.lastAssistantText() !== "background completion handled") {
  throw new Error(`unexpected final response: ${session.lastAssistantText()}`)
}

await context.fiber.dispose()
console.log("background job wakeup acceptance passed")
