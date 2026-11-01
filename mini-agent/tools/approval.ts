import { Service, type Context } from "@deepseek-ai/cordis"
import { emitSafelyFrom } from "../events.js"
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from "./permission.js"

export type ApprovalPolicy = "ask" | "never"

declare module "@deepseek-ai/cordis" {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    "approval/request": (
      request: ApprovalRequest,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    "approval/asked": (request: ApprovalRequest) => void
    "approval/decided": (
      request: ApprovalRequest,
      outcome: ApprovalOutcome,
    ) => void
  }
}

const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = [
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
]

/** 管理一次审批请求，不执行工具本身。 */
export class ApprovalService extends Service {
  private policy: ApprovalPolicy = "ask"

  constructor(ctx: Context) {
    super(ctx, "approval")
  }

  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy
  }

  getPolicy(): ApprovalPolicy {
    return this.policy
  }

  /** 通过 approval/request waterfall 获取并规范化审批结果。 */
  async request(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    signal?.throwIfAborted()

    if (this.policy === "never") {
      const outcome: ApprovalOutcome = "rejected"
      emitSafelyFrom(this.ctx, this, "approval/decided", request, outcome)
      return outcome
    }

    emitSafelyFrom(this.ctx, this, "approval/asked", request)

    let raw: unknown
    try {
      raw = await this.ctx.waterfall(
        this,
        "approval/request",
        request,
        async () => "unavailable",
      )
    } catch (error) {
      if (signal?.aborted) throw error
      raw = "unavailable"
    }

    const outcome = normalizeApprovalOutcome(raw)
    emitSafelyFrom(this.ctx, this, "approval/decided", request, outcome)
    signal?.throwIfAborted()
    return outcome
  }
}

function normalizeApprovalOutcome(value: unknown): ApprovalOutcome {
  return typeof value === "string" && APPROVAL_OUTCOMES.includes(value as ApprovalOutcome)
    ? value as ApprovalOutcome
    : "unavailable"
}

export const approvalPlugin = {
  name: "approval",

  apply(ctx: Context) {
    new ApprovalService(ctx)
  },
}
