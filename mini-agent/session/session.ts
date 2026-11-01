import type {
  AssistantReply,
  Message,
  ToolExecution,
  ToolResult,
  UserMessage,
} from "../types.js"
import { randomUUID } from "node:crypto"
import type { SessionStore } from "./store.js"
import {
  deriveMessages,
  deriveSurfaceEntries,
  lastAssistantText as findLastAssistantText,
  validateToolCallPairs,
} from "./projection.js"
import type { ToolPairValidation } from "./projection.js"
import {
  compactionMessages as getCompactionMessages,
  planCompaction as buildCompactionPlan,
  type CompactionPlan,
  type CompactionPolicy,
  type CompactionTrigger,
} from "./compaction.js"
import type { RequestEnvelope, TokenMeter } from "./token-meter.js"
import type { SessionLineage } from "../subagents/types.js"
import type { SubagentStopReason } from "../subagents/types.js"

export type SurfaceOp =
  | "append"
  | {
      op: "replace"
      start: number
      end: number
    }

export type TurnEndReason =
  | { kind: "completed" }
  | { kind: "blocked"; reason: string }
  | { kind: "aborted"; reason: string }
  | { kind: "max-tokens" }
  | { kind: "error"; error: string }

export type SessionApprovalOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable"

export type CompactionSummary = Readonly<{
  compactionId: string
  summary: string
  shadowedRange: { start: number; end: number }
  shadowedSeqs: number[]
}>

export type CompactionResult = Readonly<{
  compactionId: string
  summary: string
  shadowedRange: { start: number; end: number }
  shadowedSeqs: number[]
  retainedSeqs: number[]
}>

export type SessionEventMap = {
  "session/start": {
    data: {
      sessionId: string
      sessionName: string
      cwd?: string
      parentSession?: string
      delegationDepth?: number
    }
    surfaceOp?: never
  }
  "session/rename": {
    data: {
      sessionId: string
      sessionName: string
    }
    surfaceOp?: never
  }
  "approval/decided": {
    data: {
      callId: string
      toolName: string
      outcome: SessionApprovalOutcome
    }
    surfaceOp?: never
  }
  "compaction/start": {
    data: { compactionId: string; turn?: number | null }
    surfaceOp?: never
  }
  "compaction/summary": {
    data: CompactionSummary
    surfaceOp?: never
  }
  "compaction/end": {
    data: { compactionId: string; turn?: number | null; error?: string }
    surfaceOp?: never
  }
  "tool/call": {
    data: ToolExecution
    surfaceOp?: never
  }
  "user/message": {
    data: UserMessage
    surfaceOp: SurfaceOp
  }
  "assistant/message": {
    data: AssistantReply
    surfaceOp: SurfaceOp
  }
  "tool/result": {
    data: ToolResult
    surfaceOp: SurfaceOp
  }
  "turn/start": {
    data: { turn: number }
    surfaceOp?: never
  }
  "turn/end": {
    data: { turn: number; reason: TurnEndReason }
    surfaceOp?: never
  }
  "step/start": {
    data: { turn: number; step: number }
    surfaceOp?: never
  }
  "step/end": {
    data: { turn: number; step: number }
    surfaceOp?: never
  }
  "subagent/catalog": {
    data: {
      childSessionId: string
      mode: "one-shot"
      name: string
      delegationDepth: number
      createdAt: number
    }
    surfaceOp?: never
  }
  "subagent/settled": {
    data: {
      childSessionId: string
      stopReason: SubagentStopReason
      finishedAt: number
    }
    surfaceOp?: never
  }
}

export type SessionEventInput = {
  [K in keyof SessionEventMap]: {
    type: K
  } & SessionEventMap[K]
}[keyof SessionEventMap]

export type LogEntry = Readonly<SessionEventInput & {
  seq: number
  time: number
}>

export class Session {
  private readonly log: LogEntry[] = []
  private nextSeq = 0
  private _cwd?: string
  private readonly _parentSession?: string
  private readonly _delegationDepth: number
  private readonly store?: SessionStore
  readonly sessionId: string
  private _sessionName: string
  private readonly approvalOutcomes = new Map<string, {
    toolName: string
    outcome: SessionApprovalOutcome
  }>()
  private recoveryNotice?: string
  private initialized = false
  private pending: Promise<void> = Promise.resolve()
  private compactionRunning = false

  constructor(
    store?: SessionStore,
    metadata: {
      sessionId?: string
      sessionName?: string
      lineage?: SessionLineage
    } = {},
  ) {
    this.store = store
    this.sessionId = metadata.sessionId ?? `session-${randomUUID()}`
    this._sessionName = metadata.sessionName ?? "Untitled session"
    const lineage = normalizeSessionLineage(metadata.lineage)
    this._parentSession = lineage.parentSession
    this._delegationDepth = lineage.delegationDepth
  }

  /** 从已读取的事件恢复一个 Session。 */
  static restore(store: SessionStore, entries: readonly LogEntry[]): Session {
    const first = entries[0]
    if (!first || first.type !== "session/start") {
      throw new Error("Session log must start with session/start")
    }

    const session = new Session(store, {
      sessionId: first.data.sessionId,
      sessionName: first.data.sessionName,
      lineage: {
        ...(first.data.parentSession
          ? { parentSession: first.data.parentSession }
          : {}),
        delegationDepth: first.data.delegationDepth ?? 0,
      },
    })
    session._cwd = first.data.cwd

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      if (!entry || entry.seq !== index || !Number.isSafeInteger(entry.time)) {
        throw new Error(`Invalid Session sequence at index ${index}`)
      }
      if (index > 0 && entry.type === "session/start") {
        throw new Error("Session log contains duplicate session/start")
      }
      validateEvent(entry)
      if (entry.type === "session/rename") {
        if (entry.data.sessionId !== session.sessionId) {
          throw new Error("Session rename targets a different session")
        }
        session._sessionName = entry.data.sessionName
      }
      if (entry.type === "approval/decided") {
        session.approvalOutcomes.set(entry.data.callId, {
          toolName: entry.data.toolName,
          outcome: entry.data.outcome,
        })
      }
      session.log.push(Object.freeze({ ...entry }))
    }

    session.nextSeq = entries.length
    session.initialized = true
    return session
  }

  /** 返回日志末尾未闭合的 turn 和 step。 */
  interruptedActivity(): { turn: number; step?: number } | undefined {
    let turn: number | undefined
    let step: number | undefined
    for (const entry of this.log) {
      if (entry.type === "turn/start") {
        turn = entry.data.turn
        step = undefined
      } else if (entry.type === "step/start" && turn === entry.data.turn) {
        step = entry.data.step
      } else if (entry.type === "step/end" && turn === entry.data.turn
        && step === entry.data.step) {
        step = undefined
      } else if (entry.type === "turn/end" && turn === entry.data.turn) {
        turn = undefined
        step = undefined
      }
    }
    return turn === undefined ? undefined : { turn, ...(step === undefined ? {} : { step }) }
  }

  /** 关闭恢复时发现的未完成 turn，不重跑工具。 */
  async recoverInterruptedTurn(): Promise<boolean> {
    const activity = this.interruptedActivity()
    if (!activity) return false
    if (activity.step !== undefined) {
      await this.append({
        type: "step/end",
        data: { turn: activity.turn, step: activity.step },
      })
    }
    await this.append({
      type: "turn/end",
      data: {
        turn: activity.turn,
        reason: { kind: "aborted", reason: "previous turn interrupted" },
      },
    })
    this.recoveryNotice = "Previous turn interrupted"
    return true
  }

  /** 读取并消费一次恢复提示。 */
  consumeRecoveryNotice(): string | undefined {
    const notice = this.recoveryNotice
    this.recoveryNotice = undefined
    return notice
  }

  get cwd(): string | undefined {
    return this._cwd
  }

  get sessionName(): string {
    return this._sessionName
  }

  get parentSession(): string | undefined {
    return this._parentSession
  }

  get delegationDepth(): number {
    return this._delegationDepth
  }

  /** 返回可写入 Session 元数据的血缘。 */
  lineage(): SessionLineage {
    return {
      ...(this._parentSession ? { parentSession: this._parentSession } : {}),
      delegationDepth: this._delegationDepth,
    }
  }

  /** 在会话产生历史前绑定工作目录。 */
  bindCwd(cwd: string): void {
    if (this._cwd === cwd) return
    if (this._cwd !== undefined) {
      throw new Error("session workspace cannot be changed")
    }
    if (this.log.length > 0) {
      throw new Error("session workspace must be bound before the first message")
    }
    if (cwd.trim().length === 0) {
      throw new Error("session workspace must not be empty")
    }
    this._cwd = cwd
  }

  async append(entry: SessionEventInput): Promise<LogEntry> {
    const operation = this.pending.then(async () => {
      if (!this.initialized) {
        await this.appendRecord({
          type: "session/start",
          data: {
            sessionId: this.sessionId,
            sessionName: this._sessionName,
            ...(this._cwd ? { cwd: this._cwd } : {}),
            ...(this._parentSession ? { parentSession: this._parentSession } : {}),
            delegationDepth: this._delegationDepth,
          },
        })
        this.initialized = true
      }
      return this.appendRecord(entry)
    })
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async appendRecord(entry: SessionEventInput): Promise<LogEntry> {
    validateEvent(entry)

    const record = Object.freeze({
      ...entry,
      seq: this.nextSeq,
      time: Date.now(),
    })

    if (this.store) await this.store.append(record)
    this.nextSeq += 1
    this.log.push(record)
    if (record.type === "session/rename") this._sessionName = record.data.sessionName
    if (record.type === "approval/decided") {
      this.approvalOutcomes.set(record.data.callId, {
        toolName: record.data.toolName,
        outcome: record.data.outcome,
      })
    }
    return record
  }

  /** 追加名称变更事件；空名称不允许持久化。 */
  async rename(name: string): Promise<LogEntry | undefined> {
    const sessionName = name.trim()
    if (sessionName.length === 0) {
      throw new Error("session name must not be empty")
    }
    if (sessionName === this._sessionName) return undefined
    return this.append({
      type: "session/rename",
      data: { sessionId: this.sessionId, sessionName },
    })
  }

  /** 返回可恢复的工具审批决定。 */
  approvalDecisions(): ReadonlyMap<string, {
    toolName: string
    outcome: SessionApprovalOutcome
  }> {
    return new Map(this.approvalOutcomes)
  }

  entries(): readonly LogEntry[] {
    return this.log.slice()
  }

  /** 返回 surface 已发生替换的次数，用于判断压缩是否真正推进。 */
  surfaceGeneration(): number {
    return this.log.reduce(
      (generation, entry) => generation + (
        entry.surfaceOp !== undefined && entry.surfaceOp !== "append" ? 1 : 0
      ),
      0,
    )
  }

  /** 返回当前会话可用于模型请求的消息。 */
  messages(): Message[] {
    return deriveMessages(this.log)
  }

  /** 校验当前 surface 上工具调用和结果的配对状态。 */
  toolCallPairs(): ToolPairValidation {
    return validateToolCallPairs(this.log)
  }

  /** 根据当前消息 surface 规划压缩范围，不修改日志。 */
  planCompaction(
    trigger: CompactionTrigger,
    policy: CompactionPolicy,
    meter: TokenMeter,
    envelope?: RequestEnvelope,
  ): CompactionPlan | null {
    return buildCompactionPlan(this.log, trigger, policy, meter, envelope)
  }

  /** 返回压缩计划覆盖的消息，供后续摘要器使用。 */
  compactionMessages(plan: CompactionPlan): Message[] {
    return getCompactionMessages(this.log, plan)
  }

  /** 生成摘要并用 replace 隐藏计划范围，原始日志仍然保留。 */
  async compact(
    plan: CompactionPlan,
    summarize: (messages: Message[]) => Promise<string>,
    turn: number | null = null,
  ): Promise<CompactionResult> {
    this.validateCompactionPlan(plan)
    if (this.compactionRunning || activeCompactionId(this.log)) {
      throw new Error("Compaction already active")
    }

    this.compactionRunning = true
    const compactionId = `compaction-${randomUUID()}`
    let started = false

    try {
      await this.append({
        type: "compaction/start",
        data: { compactionId, turn },
      })
      started = true
      const summary = (await summarize(this.compactionMessages(plan))).trim()
      if (summary.length === 0) throw new Error("Compaction summary is empty")

      await this.append({
        type: "compaction/summary",
        data: {
          compactionId,
          summary,
          shadowedRange: plan.shadowedRange,
          shadowedSeqs: plan.shadowedSeqs,
        },
      })
      await this.append({
        type: "user/message",
        data: {
          role: "user",
          text: `<compacted-summary>\n${summary}\n</compacted-summary>`,
        },
        surfaceOp: {
          op: "replace",
          start: plan.shadowedRange.start,
          end: plan.shadowedRange.end,
        },
      })
      await this.append({
        type: "compaction/end",
        data: { compactionId, turn },
      })

      return {
        compactionId,
        summary,
        shadowedRange: plan.shadowedRange,
        shadowedSeqs: plan.shadowedSeqs,
        retainedSeqs: plan.retainedSeqs,
      }
    } catch (error) {
      if (!started) throw error
      try {
        await this.append({
          type: "compaction/end",
          data: {
            compactionId,
            turn,
            error: error instanceof Error ? error.message : String(error),
          },
        })
      } catch {
        // 保留摘要失败本身，持久化失败由下一次恢复检查发现。
      }
      throw error
    } finally {
      this.compactionRunning = false
    }
  }

  private validateCompactionPlan(plan: CompactionPlan): void {
    const surface = deriveSurfaceEntries(this.log)
    const currentSeqs = surface.map((entry) => entry.seq)
    const expectedShadowed = currentSeqs.slice(0, plan.shadowedSeqs.length)
    const expectedRetained = currentSeqs.slice(plan.shadowedSeqs.length)
    if (!sameNumbers(plan.shadowedSeqs, expectedShadowed) ||
      !sameNumbers(plan.retainedSeqs, expectedRetained)) {
      throw new Error("Compaction plan is stale")
    }
    const first = plan.shadowedSeqs[0]
    const last = plan.shadowedSeqs.at(-1)
    if (first === undefined || last === undefined ||
      plan.shadowedRange.start !== first || plan.shadowedRange.end !== last) {
      throw new Error("Compaction plan has an invalid range")
    }

    const pairing = validateToolCallPairs(this.log)
    const shadowed = new Set(plan.shadowedSeqs)
    for (const pair of pairing.pairs) {
      if (shadowed.has(pair.callSeq) !== shadowed.has(pair.resultSeq)) {
        throw new Error("Compaction plan splits a tool call pair")
      }
    }
  }

  /** 返回最近一条 assistant 文本。 */
  lastAssistantText(): string {
    return findLastAssistantText(this.messages())
  }

  /** 返回日志中最新的 turn 编号。 */
  lastTurn(): number {
    let lastTurn = 0
    for (const entry of this.log) {
      if (entry.type !== "turn/start" && entry.type !== "turn/end") continue
      if (entry.data.turn > lastTurn) lastTurn = entry.data.turn
    }
    return lastTurn
  }

  /** 返回最近一次 turn 的结束原因。 */
  lastTurnEndReason(): TurnEndReason | undefined {
    for (let index = this.log.length - 1; index >= 0; index -= 1) {
      const entry = this.log[index]
      if (entry?.type === "turn/end") return entry.data.reason
    }
    return undefined
  }
}

function validateEvent(entry: SessionEventInput): void {
  const rawType = (entry as unknown as { type?: unknown }).type
  const knownTypes: readonly string[] = Object.keys(eventDataRules)
  if (typeof rawType !== "string" || !knownTypes.includes(rawType)) {
    throw new Error(`Unknown session event type: ${String(rawType)}`)
  }

  const rule = eventDataRules[entry.type]
  if (!rule(entry.data)) {
    if (entry.type === "compaction/summary") {
      throw new Error(
        `compaction/summary contains invalid event data: ${compactionSummaryError(entry.data)}`,
      )
    }
    throw new Error(`${entry.type} contains invalid event data`)
  }

  const surfaceOp = (entry as SessionEventInput & { surfaceOp?: unknown }).surfaceOp
  const isSurfaceEvent = surfaceEventTypes.has(entry.type)
  if (isSurfaceEvent && !isSurfaceOp(surfaceOp)) {
    throw new Error(`${entry.type} contains invalid surface operation`)
  }
  if (!isSurfaceEvent && surfaceOp !== undefined) {
    throw new Error(`${entry.type} cannot contain a surface operation`)
  }
}

const surfaceEventTypes = new Set<keyof SessionEventMap>([
  "user/message",
  "assistant/message",
  "tool/result",
])

function isSurfaceOp(value: unknown): value is SurfaceOp {
  if (value === "append") return true
  if (!value || typeof value !== "object") return false

  const operation = value as Record<string, unknown>
  return (
    operation.op === "replace" &&
    Number.isSafeInteger(operation.start) &&
    Number.isSafeInteger(operation.end) &&
    Number(operation.start) >= 0 &&
    Number(operation.end) >= 0
  )
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function activeCompactionId(entries: readonly LogEntry[]): string | undefined {
  let active: string | undefined
  for (const entry of entries) {
    if (entry.type === "compaction/start") {
      if (active !== undefined) return active
      active = entry.data.compactionId
    } else if (
      entry.type === "compaction/end" &&
      entry.data.compactionId === active
    ) {
      active = undefined
    }
  }
  return active
}

const eventDataRules: Record<keyof SessionEventMap, (data: unknown) => boolean> = {
  "session/start": (data) => {
    const metadata = data as {
      sessionId?: unknown
      sessionName?: unknown
      cwd?: unknown
      parentSession?: unknown
      delegationDepth?: unknown
    } | undefined
    const delegationDepth = metadata?.delegationDepth ?? 0
    return (
      typeof metadata?.sessionId === "string" &&
      metadata.sessionId.length > 0 &&
      typeof metadata.sessionName === "string" &&
      metadata.sessionName.length > 0 &&
      (metadata.cwd === undefined || typeof metadata.cwd === "string") &&
      isSessionLineage(metadata.parentSession, delegationDepth)
    )
  },
  "session/rename": (data) => {
    const rename = data as {
      sessionId?: unknown
      sessionName?: unknown
    } | undefined
    return (
      typeof rename?.sessionId === "string" &&
      rename.sessionId.length > 0 &&
      typeof rename.sessionName === "string" &&
      rename.sessionName.trim().length > 0
    )
  },
  "approval/decided": (data) => {
    const decision = data as {
      callId?: unknown
      toolName?: unknown
      outcome?: unknown
    } | undefined
    return (
      typeof decision?.callId === "string" &&
      decision.callId.length > 0 &&
      typeof decision.toolName === "string" &&
      decision.toolName.length > 0 &&
      (decision.outcome === "allowed-once" ||
        decision.outcome === "rejected" ||
        decision.outcome === "cancelled" ||
        decision.outcome === "unavailable")
    )
  },
  "compaction/start": isCompactionStart,
  "compaction/summary": isCompactionSummary,
  "compaction/end": isCompactionEnd,
  "tool/call": (data) => {
    const call = data as Partial<ToolExecution> | undefined
    return (
      typeof call?.id === "string" &&
      typeof call.name === "string" &&
      typeof call.arguments === "string"
    )
  },
  "user/message": (data) => {
    const message = data as Partial<UserMessage> | undefined
    return message?.role === "user" && typeof message.text === "string"
  },
  "assistant/message": (data) => {
    const message = data as Partial<AssistantReply> | undefined
    if (message?.role !== "assistant" || typeof message.text !== "string") {
      return false
    }

    return (
      message.toolCalls === undefined ||
      (Array.isArray(message.toolCalls) &&
        message.toolCalls.every(
          (call) =>
            typeof call.id === "string" &&
            typeof call.name === "string" &&
            typeof call.arguments === "string",
        ))
    )
  },
  "tool/result": (data) => {
    const result = data as Partial<ToolResult> | undefined
    return (
      result?.role === "tool" &&
      typeof result.toolCallId === "string" &&
      typeof result.text === "string" &&
      typeof result.isError === "boolean"
    )
  },
  "turn/start": isTurnBoundary,
  "turn/end": isTurnEnd,
  "step/start": isStepBoundary,
  "step/end": isStepBoundary,
  "subagent/catalog": isSubagentCatalog,
  "subagent/settled": isSubagentSettled,
}

function isSubagentCatalog(data: unknown): boolean {
  const value = data as {
    childSessionId?: unknown
    mode?: unknown
    name?: unknown
    delegationDepth?: unknown
    createdAt?: unknown
  } | undefined
  return (
    typeof value?.childSessionId === "string" &&
    value.childSessionId.length > 0 &&
    value.mode === "one-shot" &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    isPositiveInteger(value.delegationDepth) &&
    isNonNegativeInteger(value.createdAt)
  )
}

function isSubagentSettled(data: unknown): boolean {
  const value = data as {
    childSessionId?: unknown
    stopReason?: unknown
    finishedAt?: unknown
  } | undefined
  return (
    typeof value?.childSessionId === "string" &&
    value.childSessionId.length > 0 &&
    (value.stopReason === "completed" ||
      value.stopReason === "aborted" ||
      value.stopReason === "blocked" ||
      value.stopReason === "max-tokens" ||
      value.stopReason === "error") &&
    isNonNegativeInteger(value.finishedAt)
  )
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isTurnBoundary(data: unknown): boolean {
  const boundary = data as { turn?: unknown } | undefined
  return (
    boundary !== undefined &&
    Number.isSafeInteger(boundary.turn) &&
    Number(boundary.turn) >= 1
  )
}

function isCompactionStart(data: unknown): boolean {
  const value = data as { compactionId?: unknown; turn?: unknown } | undefined
  return (
    typeof value?.compactionId === "string" &&
    value.compactionId.length > 0 &&
    (value.turn === undefined || value.turn === null || isPositiveInteger(value.turn))
  )
}

function isCompactionSummary(data: unknown): boolean {
  const value = data as {
    compactionId?: unknown
    summary?: unknown
    shadowedRange?: unknown
    shadowedSeqs?: unknown
  } | undefined
  const range = value?.shadowedRange as { start?: unknown; end?: unknown } | undefined
  return (
    typeof value?.compactionId === "string" &&
    value.compactionId.length > 0 &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    isSequenceRange(range) &&
    isSequenceList(value.shadowedSeqs)
  )
}

function compactionSummaryError(data: unknown): string {
  if (!data || typeof data !== "object") return "data must be an object"
  const value = data as Record<string, unknown>
  if (typeof value.compactionId !== "string" || value.compactionId.length === 0) {
    return "compactionId must be a non-empty string"
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0) {
    return "summary must be a non-empty string"
  }
  if (!isSequenceRange(value.shadowedRange as { start?: unknown; end?: unknown })) {
    return "shadowedRange must contain non-negative integer endpoints"
  }
  if (!isSequenceList(value.shadowedSeqs)) {
    return "shadowedSeqs must be a list of non-negative integers"
  }
  return "unknown validation failure"
}

function isCompactionEnd(data: unknown): boolean {
  const value = data as {
    compactionId?: unknown
    turn?: unknown
    error?: unknown
  } | undefined
  return (
    typeof value?.compactionId === "string" &&
    value.compactionId.length > 0 &&
    (value.turn === undefined || value.turn === null || isPositiveInteger(value.turn)) &&
    (value.error === undefined || typeof value.error === "string")
  )
}

function isSequenceRange(
  value: { start?: unknown; end?: unknown } | undefined,
): boolean {
  const start = value?.start
  const end = value?.end
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    Number(start) >= 0 &&
    Number(end) >= 0
  )
}

function isSequenceList(value: unknown): boolean {
  return Array.isArray(value) && value.every((seq) => Number.isSafeInteger(seq) && Number(seq) >= 0)
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1
}

function normalizeSessionLineage(lineage?: SessionLineage): SessionLineage {
  const parentSession = lineage?.parentSession
  const delegationDepth = lineage?.delegationDepth ?? 0
  if (!isSessionLineage(parentSession, delegationDepth)) {
    throw new Error("Invalid Session lineage")
  }
  return {
    ...(parentSession ? { parentSession } : {}),
    delegationDepth,
  }
}

function isSessionLineage(parentSession: unknown, delegationDepth: unknown): boolean {
  if (!Number.isSafeInteger(delegationDepth) || Number(delegationDepth) < 0) return false
  if (parentSession === undefined) return delegationDepth === 0
  return typeof parentSession === "string" &&
    parentSession.length > 0 &&
    Number(delegationDepth) >= 1
}

function isStepBoundary(data: unknown): boolean {
  if (!isTurnBoundary(data)) return false

  const boundary = data as { step?: unknown }
  return Number.isSafeInteger(boundary.step) && Number(boundary.step) >= 1
}

function isTurnEnd(data: unknown): boolean {
  if (!isTurnBoundary(data)) return false

  const end = data as { reason?: unknown }
  if (!end.reason || typeof end.reason !== "object") return false

  const reason = end.reason as Record<string, unknown>
  if (reason.kind === "completed") return true
  if (reason.kind === "blocked") return typeof reason.reason === "string"
  if (reason.kind === "max-tokens") return true
  if (reason.kind === "aborted") return typeof reason.reason === "string"
  return reason.kind === "error" && typeof reason.error === "string"
}
