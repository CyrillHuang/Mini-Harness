export type JobStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "killed"

export type JobSnapshot = {
  id: string
  kind: string
  label: string
  ownerSession?: string
  status: JobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
}

export type JobRead = {
  text: string
  job: JobSnapshot
}

/** 接收后台任务完成通知的最小 owner 能力。 */
export type JobOwner = {
  sessionId: string
  status: "idle" | "running"
  inject: (text: string) => void
  followup: (text: string) => void
}

export type JobRunner = (context: {
  signal: AbortSignal
  write: (chunk: string) => void
}) => void | Promise<void>

export type JobStart = {
  kind: string
  label: string
  owner?: JobOwner
  ownerSession?: string
  run: JobRunner
}

export type JobDoneListener = (
  job: JobSnapshot,
  owner: JobOwner | undefined,
) => void | PromiseLike<void>
