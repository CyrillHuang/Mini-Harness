import type { Context } from "@deepseek-ai/cordis"
import type { Tool } from "../types.js"

type JobControlArgs = {
  job_id?: unknown
  wait?: unknown
  timeout_ms?: unknown
}

export type JobToolsOptions = {
  /** 连续后台完成事件最多主动唤醒空闲 Agent 的次数。 */
  maxConsecutiveWakeups?: number
}

function ownerSession(ctx: Context): string {
  return ctx.sessions.current().sessionId
}

function requiredJobId(args: JobControlArgs): string {
  if (typeof args.job_id !== "string" || !args.job_id) {
    throw new Error("job_id must be a non-empty string")
  }
  return args.job_id
}

function createJobTools(ctx: Context): Tool[] {
  return [
    {
      schema: {
        type: "function",
        function: {
          name: "job_list",
          description: "List background jobs owned by the current session.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      isConcurrencySafe: () => true,
      execute() {
        return JSON.stringify(ctx.jobs.list(ownerSession(ctx)))
      },
    },
    {
      schema: {
        type: "function",
        function: {
          name: "job_output",
          description: "Read new output from a background job, optionally waiting for it to finish.",
          parameters: {
            type: "object",
            properties: {
              job_id: { type: "string", description: "Job id returned by the tool that started it" },
              wait: { type: "boolean", description: "Wait for the job to finish before reading" },
              timeout_ms: { type: "number", description: "Maximum wait in milliseconds" },
            },
            required: ["job_id"],
            additionalProperties: false,
          },
        },
      },
      async execute(rawArgs, signal) {
        const args = rawArgs as JobControlArgs
        const id = requiredJobId(args)
        const owner = ownerSession(ctx)
        if (args.wait === true) {
          const timeout = args.timeout_ms === undefined ? 30_000 : Number(args.timeout_ms)
          await ctx.jobs.wait(id, timeout, owner, signal)
        }
        return JSON.stringify(ctx.jobs.read(id, owner))
      },
    },
    {
      schema: {
        type: "function",
        function: {
          name: "job_kill",
          description: "Request cancellation of a background job.",
          parameters: {
            type: "object",
            properties: {
              job_id: { type: "string", description: "Job id returned by the tool that started it" },
            },
            required: ["job_id"],
            additionalProperties: false,
          },
        },
      },
      execute(rawArgs) {
        const id = requiredJobId(rawArgs as JobControlArgs)
        const owner = ownerSession(ctx)
        const outcome = ctx.jobs.kill(id, owner)
        return JSON.stringify({ outcome, job: ctx.jobs.get(id, owner) })
      },
    },
  ]
}

/** 注册模型控制工具，并把后台任务完成消息交给所属 Agent。 */
export const jobToolsPlugin = {
  name: "job-tools",
  inject: ["jobs", "toolRegistry", "prompt", "agent", "sessions"],

  apply(ctx: Context, options: JobToolsOptions = {}) {
    const maxConsecutiveWakeups = positiveInteger(
      options.maxConsecutiveWakeups ?? 2,
      "maxConsecutiveWakeups",
    )
    ctx.effect(() => {
      const wakeCounts = new Map<string, number>()
      const disposers = createJobTools(ctx).map((tool) => ctx.toolRegistry.register(tool))
      const removeGuidance = ctx.prompt.section(
        "tools:jobs",
        1010,
        "Track every background job id you start. Continue independent work instead of polling. "
          + "Before answering, collect relevant jobs with job_output or stop unneeded jobs with job_kill.",
      )
      const removeListener = ctx.jobs.onDone((job, owner) => {
        const notice = `Background job ${job.id} (${job.label}) finished with status ${job.status}. Use job_output to read its output.`
        if (!owner) return
        if (owner.status === "running") {
          owner.inject(notice)
          return
        }

        const used = wakeCounts.get(owner.sessionId) ?? 0
        if (used < maxConsecutiveWakeups) {
          wakeCounts.set(owner.sessionId, used + 1)
          owner.followup(notice)
        } else {
          // 不唤醒，但保留到下一次真实用户 turn 的 next-step Inbox。
          owner.inject(notice)
        }
      })
      const removeResetListener = ctx.on("agent/user-input", ({ sessionId }) => {
        wakeCounts.delete(sessionId)
      })

      return () => {
        removeResetListener()
        removeListener()
        removeGuidance()
        for (const dispose of disposers.reverse()) dispose()
      }
    }, "background job controls")
  },
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
