import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { JobService } from "../jobs/service.js"
import type { JobOwner } from "../jobs/types.js"
import type { Tool } from "../types.js"

const execAsync = promisify(exec)

export function createBashTool(
  jobs?: JobService,
  getOwner?: () => JobOwner | undefined,
): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "bash",
        description: jobs
          ? "Execute a shell command and return its output. Set run_in_background for long-running commands."
          : "Execute a shell command and return its output.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to execute" },
            description: { type: "string", description: "Short explanation of the command" },
            ...(jobs ? {
              run_in_background: {
                type: "boolean",
                description: "Run in the background and return a job id immediately",
              },
            } : {}),
          },
          required: ["command", "description"],
          additionalProperties: false,
        },
      },
    },
    async execute(args, signal, cwd) {
      const { command, run_in_background: background } = args as {
        command: string
        description: string
        run_in_background?: boolean
      }

      if (background) {
        if (!jobs || !getOwner) {
          throw new Error("Background jobs are unavailable")
        }
        const owner = getOwner()
        if (!owner) throw new Error("Background jobs require an active agent")
        signal?.throwIfAborted()
        const job = jobs.start({
          kind: "bash",
          label: command,
          owner,
          run: ({ signal: jobSignal, write }) => runBackgroundCommand(
            command,
            cwd,
            jobSignal,
            write,
          ),
        })
        return JSON.stringify({ kind: "background", jobId: job.id })
      }

      try {
        const result = await execAsync(command, {
          encoding: "utf8",
          shell: "/bin/bash",
          cwd,
          signal,
        })
        return `${result.stdout}${result.stderr}`
      } catch (error) {
        const failure = error as {
          message?: string
          stdout?: string
          stderr?: string
          code?: number | string
        }
        const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`
        if (output) {
          throw new Error(
            `Command failed${failure.code === undefined ? "" : ` (${failure.code})`}:\n${output}`,
          )
        }
        throw new Error(failure.message ?? "command failed")
      }
    },
  }
}

function runBackgroundCommand(
  command: string,
  cwd: string | undefined,
  signal: AbortSignal,
  write: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = exec(command, {
      encoding: "utf8",
      shell: "/bin/bash",
      cwd,
      signal,
    }, (error) => {
      if (error) {
        // Non-zero command exits are completed command results; spawn and
        // infrastructure failures reject the runner and become failed jobs.
        if (typeof (error as { code?: unknown }).code === "number") resolve()
        else reject(error)
      } else resolve()
    })
    child.stdout?.on("data", (chunk: string | Buffer) => write(String(chunk)))
    child.stderr?.on("data", (chunk: string | Buffer) => write(String(chunk)))
  })
}
