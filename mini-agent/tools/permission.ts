import type { ToolExecution } from "../types.js"

/** 工具执行前的策略决定。 */
export type ToolPreDecision =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string }

/** 需要交给外部回答者处理的审批请求。 */
export type ApprovalRequest = {
  arguments?: string
  toolName: string
  callId: string
  reason: string
}

/** 审批流程的结果，执行层会据此决定是否放行。 */
export type ApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable"

/** 代表 TUI、测试或其他外部审批入口。 */
export type ApprovalAnswerer = (
  request: ApprovalRequest,
) => Promise<unknown>

/** 只能返回拒绝理由或弃权，不能主动放行。 */
export type ToolGuard = (
  execution: ToolExecution,
) => string | undefined
