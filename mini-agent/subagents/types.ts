import type { Context } from "@deepseek-ai/cordis"

/** 可持久化的 Session 血缘；根 Session 的 depth 为 0。 */
export type SessionLineage = Readonly<{
  parentSession?: string
  delegationDepth: number
}>

/** 一次运行中的完整血缘；subagentDepth 不写入 Session。 */
export type Lineage = Readonly<SessionLineage & {
  subagentDepth: number
}>

export type SubagentStopReason =
  | "completed"
  | "aborted"
  | "blocked"
  | "max-tokens"
  | "error"

/** 一次 one-shot 子 Agent 最终交回父 Agent 的结果。 */
export type SubagentResult = Readonly<{
  childSessionId: string
  finalText: string
  stopReason: SubagentStopReason
  error?: string
  /** 子 Agent 到达最终回答前发生过的工具级失败。 */
  toolErrors: readonly SubagentToolError[]
}>

export type SubagentToolError = Readonly<{
  toolCallId: string
  text: string
}>

/** 子作用域创建后、正式运行前的配置窗口。 */
export type SubagentSetup = (
  ctx: Context,
  signal: AbortSignal,
) => void | Promise<void>

/** 已成功发布的一次子 Agent 运行。 */
export type SubagentRun = Readonly<{
  id: string
  result: Promise<SubagentResult>
  dispose: () => Promise<void>
}>
