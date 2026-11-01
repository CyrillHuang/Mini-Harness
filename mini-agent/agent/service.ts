import { Service, type Context } from "@deepseek-ai/cordis"
import { emitSafelyFrom } from "../events.js"
import { Inbox, type InboxTarget } from "./inbox.js"
import {
  type CompactionResult,
  type Session,
  type TurnEndReason,
} from "../session/session.js"
import type {
  CompactionPlan,
  CompactionPolicy,
} from "../session/compaction.js"
import type { LlmModelInfo } from "../llm/service.js"
import {
  normalizeLlmError,
  type LlmFailure,
} from "../llm/errors.js"
import {
  createTokenMeter,
  type RequestEnvelope,
  type TokenMeter,
} from "../session/token-meter.js"
import type { AssistantReply, LlmDelta, Message, ToolCall, UserMessage } from "../types.js"
import type { ToolExecutionResult } from "../types.js"
import {
  createOrderedCommitter,
  scheduleToolCalls,
  type ToolCompletion,
} from "../tools/scheduler.js"

declare module "@deepseek-ai/cordis" {
  interface Context {
    agent: AgentPlugin
  }

  interface Events {
    "agent/pre-step": (
      payload: {
        messages: UserMessage[]
        turn: number
        step: number
        signal: AbortSignal
      },
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>
    "agent/error": (payload: {
      turn: number
      step: number
      error: unknown
    }) => void
    "agent/request-error": (
      payload: {
        turn: number
        step: number
        failure: LlmFailure
        signal: AbortSignal
        retryCount: number
        envelope: RequestEnvelope
      },
      next: () => Promise<RequestErrorAction>,
    ) => Promise<RequestErrorAction>
    "agent/assistant-delta": (delta: LlmDelta) => void
    "agent/assistant-attempt-discard": (payload: {
      turn: number
      step: number
    }) => void
    "agent/user-input": (payload: {
      sessionId: string
    }) => void
    "agent/turn-start": (payload: {
      turn: number
    }) => void
    "agent/turn-end": (payload: {
      turn: number
      reason: TurnEndReason
    }) => void
  }
}

type Phase =
  | { kind: "idle"; lastTurn: number }
  | {
      kind: "running"
      abort: AbortController
      turn: number
      step: number
    }

type RunningPhase = Extract<Phase, { kind: "running" }>

export type PreStepDecision =
  | { kind: "enter"; messages: UserMessage[] }
  | { kind: "reject"; reason: string }

export type RequestErrorAction = { kind: "retry" } | undefined

type StepResult = Extract<
  TurnEndReason,
  { kind: "completed" | "max-tokens" }
> | null

export type AgentRunOptions = {
  userText?: string
}

export type AgentOptions = {
  provider: string
  maxSteps?: number
  maxParallelTools?: number
  compaction?: AgentCompactionOptions
}

export type AgentCompactionOptions = {
  enabled?: boolean
  contextWindow?: number
  thresholdRatio?: number
  retainRatio?: number
  meter?: TokenMeter
}

export type AgentRunResult = {
  session: Session
  messages: Message[]
  finalText: string
  reason: TurnEndReason
}

const SUMMARY_SYSTEM_PROMPT = `You summarize conversation history for a later assistant turn.

Preserve:
- the user's goals, decisions, and constraints
- important facts and conclusions
- completed tool actions and relevant results
- unresolved tasks or pending questions

Do not answer the user, call tools, or invent facts.
Return only a concise summary that can be used as context.`

export class AgentPlugin extends Service {
  static inject = ["llm", "toolRegistry", "prompt", "sessions"]

  private readonly context: Context
  readonly options: AgentOptions
  private readonly inbox = new Inbox()
  private phase: Phase = { kind: "idle", lastTurn: 0 }
  private activityDone: Promise<void> = Promise.resolve()
  private readonly compactionEnabled: boolean
  private readonly compactionPolicy: CompactionPolicy
  private readonly tokenMeter: TokenMeter

  constructor(
    ctx: Context,
    options: AgentOptions = {
      provider: process.env.MINI_AGENT_PROVIDER ?? "qwen",
    },
  ) {
    super(ctx, "agent")
    this.context = ctx
    this.options = options
    const compaction = options.compaction
    const modelInfo = this.readModelInfo()
    this.compactionEnabled = compaction?.enabled ?? true
    this.compactionPolicy = {
      contextWindow: compaction?.contextWindow ?? modelInfo.contextWindow ?? readContextWindow(),
      thresholdRatio: compaction?.thresholdRatio ?? 0.8,
      retainRatio: compaction?.retainRatio ?? 0.2,
    }
    this.tokenMeter = compaction?.meter ?? createTokenMeter()
    this.context.effect(
      () => this.context.on("agent/request-error", (payload, next) =>
        this.handleRequestError(payload, next)),
      "agent context overflow recovery",
    )
  }

  get status(): "idle" | "running" {
    return this.phase.kind
  }

  /** 通过 Context 使用共享的模型和工具服务。 */
  get llm() {
    return this.context.llm
  }

  get toolRegistry() {
    return this.context.toolRegistry
  }

  get prompt() {
    return this.context.prompt
  }

  /** 返回当前由 SessionPlugin 选中的会话。 */
  get session(): Session {
    return this.context.sessions.current()
  }

  /** Agent 的运行入口。 */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    if (options.userText !== undefined) {
      this.followup(options.userText)
      emitSafelyFrom(this.context, this, "agent/user-input", {
        sessionId: this.session.sessionId,
      })
    }

    await this.whenIdle()
    const messages = this.session.messages()
    return {
      session: this.session,
      messages,
      finalText: this.session.lastAssistantText(),
      reason: this.session.lastTurnEndReason() ?? { kind: "completed" },
    }
  }

  followup(text: string): void {
    this.send({ role: "user", text }, "next-turn", true)
  }

  steer(text: string): void {
    this.send({ role: "user", text }, "next-step", true)
  }

  inject(text: string): void {
    this.send({ role: "user", text }, "next-step", false)
  }

  /** 用当前模型生成压缩摘要，并执行 Session 的替换。 */
  async compact(
    plan: CompactionPlan,
    turn?: number | null,
  ): Promise<CompactionResult> {
    const signal = this.phase.kind === "running"
      ? this.phase.abort.signal
      : undefined
    return this.session.compact(
      plan,
      (messages) => this.summarizeMessages(messages, signal),
      turn ?? (this.phase.kind === "running" ? this.phase.turn : null),
    )
  }

  /** 只调用模型生成摘要，不写入 Session。 */
  async summarizeMessages(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<string> {
    if (messages.length === 0) {
      throw new Error("Cannot summarize an empty message list")
    }

    signal?.throwIfAborted()
    const transcript: UserMessage[] = [{
      role: "user",
      text: formatSummaryTranscript(messages),
    }]
    const reply = await this.llm.request(
      this.options.provider,
      transcript,
      [],
      signal,
      SUMMARY_SYSTEM_PROMPT,
    )
    signal?.throwIfAborted()

    if (reply.toolCalls?.length) {
      throw new Error("Summary model returned tool calls")
    }

    const summary = reply.text.trim()
    if (summary.length === 0) {
      throw new Error("Summary model returned empty text")
    }
    return summary
  }

  /** 请求停止当前活动；whenIdle 会等待活动收敛后返回。 */
  cancel(reason = "cancelled"): void {
    if (this.phase.kind === "running") this.phase.abort.abort(reason)
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (message.text.length === 0) {
      throw new Error("agent input must not be empty")
    }

    // 当前活动已中止时，输入不能再归属于旧 turn。
    const effectiveTarget =
      target === "next-step" &&
      this.phase.kind === "running" &&
      this.phase.abort.signal.aborted
        ? "next-turn"
        : target

    this.inbox.enqueue(effectiveTarget, message)

    if (wakeup) this.wakeDriver()
  }

  claim(target: InboxTarget): UserMessage[] {
    return this.inbox.claim(target)
  }

  pending(target?: InboxTarget): number {
    return this.inbox.pending(target)
  }

  /** 执行一次非流式模型工作。 */
  private async step(): Promise<StepResult> {
    if (this.phase.kind !== "running") {
      throw new Error("agent step requires a running phase")
    }

    const turn = this.phase.turn
    const step = this.phase.step
    this.phase.abort.signal.throwIfAborted()

    const assembly = this.prompt.assemble()
    const messages = await this.prepareMessages(assembly.system, assembly.tools)
    const reply = await this.requestReply(
      messages,
      assembly.tools,
      assembly.system,
      turn,
      step,
    )
    this.phase.abort.signal.throwIfAborted()
    await this.session.append({
      type: "assistant/message",
      data: reply,
      surfaceOp: "append",
    })

    if (reply.finishReason === "length") return { kind: "max-tokens" }
    if (reply.finishReason === "content_filter") {
      throw new Error("LLM stopped because of content filtering")
    }
    if (reply.finishReason === "tool_calls" && !reply.toolCalls?.length) {
      throw new Error("LLM ended with tool_calls but returned no tool calls")
    }
    if (!reply.toolCalls?.length) return { kind: "completed" }

    await this.executeToolCalls(reply.toolCalls)

    return null
  }

  /** 请求模型前按 Token 压力压缩旧 surface。 */
  private async prepareMessages(
    system: string,
    tools: ReturnType<typeof this.prompt.assemble>["tools"],
  ): Promise<Message[]> {
    if (!this.compactionEnabled) return this.session.messages()

    const envelope = this.requestEnvelope(system, tools)
    const plan = this.session.planCompaction(
      "pressure",
      this.compactionPolicy,
      this.tokenMeter,
      envelope,
    )
    if (!plan) return this.session.messages()

    await this.compact(plan)
    return this.session.messages()
  }

  private requestEnvelope(
    system: string,
    tools: ReturnType<typeof this.prompt.assemble>["tools"],
  ): RequestEnvelope {
    const modelInfo = this.readModelInfo()
    return {
      provider: modelInfo.provider,
      model: modelInfo.model,
      systemPrompt: system,
      toolsSchema: JSON.stringify(tools),
    }
  }

  /** 请求失败时交给 waterfall 决定是否压缩后重试。 */
  private async requestReply(
    initialMessages: Message[],
    tools: ReturnType<typeof this.prompt.assemble>["tools"],
    system: string,
    turn: number,
    step: number,
  ): Promise<AssistantReply> {
    if (this.phase.kind !== "running") {
      throw new Error("agent request requires a running phase")
    }

    let messages = initialMessages
    let retryCount = 0
    while (true) {
      try {
        return this.llm.supportsStream(this.options.provider)
          ? await this.streamReply(messages, tools, system)
          : await this.llm.request(
              this.options.provider,
              messages,
              tools,
              this.phase.abort.signal,
              system,
            )
      } catch (error) {
        // 流式请求可能已经显示了部分 delta；失败后这些内容不属于最终回复。
        emitSafelyFrom(
          this.context,
          this,
          "agent/assistant-attempt-discard",
          { turn, step },
        )
        if (this.phase.abort.signal.aborted) throw error
        const failure = normalizeLlmError(error).failure
        const action = await this.context.waterfall(
          this,
          "agent/request-error",
          {
            turn,
            step,
            failure,
            signal: this.phase.abort.signal,
            retryCount,
            envelope: this.requestEnvelope(system, tools),
          },
          async (): Promise<RequestErrorAction> => undefined,
        )
        this.phase.abort.signal.throwIfAborted()
        if (action?.kind !== "retry") throw normalizeLlmError(error)
        retryCount += 1
        messages = this.session.messages()
      }
    }
  }

  /** Provider 确认上下文超限时，压缩 surface 并允许当前请求重试一次。 */
  private async handleRequestError(
    payload: {
      turn: number
      step: number
      failure: LlmFailure
      signal: AbortSignal
      retryCount: number
      envelope: RequestEnvelope
    },
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    if (
      payload.failure.code !== "CONTEXT_WINDOW_EXCEEDED" ||
      payload.signal.aborted ||
      !this.compactionEnabled ||
      payload.retryCount >= 1
    ) return next()

    const plan = this.session.planCompaction(
      "context-overflow",
      this.compactionPolicy,
      this.tokenMeter,
      payload.envelope,
    )
    if (!plan) return next()

    const generation = this.session.surfaceGeneration()
    try {
      await this.compact(plan, payload.turn)
    } catch {
      // 替换可能已落地，摘要收尾失败不能撤销这次有效缩减。
      if (this.session.surfaceGeneration() <= generation) return next()
    }
    if (this.session.surfaceGeneration() <= generation) return next()
    return { kind: "retry" }
  }

  private readModelInfo(): LlmModelInfo {
    try {
      return this.llm.modelInfo(this.options.provider)
    } catch {
      return { provider: this.options.provider, model: this.options.provider }
    }
  }

  /** 累积流式增量，结束后还原成完整回复。 */
  private async streamReply(
    messages: Message[],
    tools: ReturnType<typeof this.prompt.assemble>["tools"],
    system: string,
  ): Promise<AssistantReply> {
    if (this.phase.kind !== "running") {
      throw new Error("stream reply requires a running phase")
    }
    const signal = this.phase.abort.signal
    let text = ""
    let usage: AssistantReply["usage"]
    let finishReason: string | undefined
    const toolCalls = new Map<number, ToolCall>()

    for await (const delta of this.llm.stream(
      this.options.provider,
      messages,
      tools,
      signal,
      system,
    )) {
      signal.throwIfAborted()
      emitSafelyFrom(this.context, this, "agent/assistant-delta", delta)
      if (delta.text) {
        text += delta.text
      }
      if (delta.usage) usage = delta.usage
      if (delta.finishReason) finishReason = delta.finishReason
      for (const part of delta.toolCalls ?? []) {
        const current = toolCalls.get(part.index) ?? {
          id: "",
          name: "",
          arguments: "",
        }
        toolCalls.set(part.index, {
          id: current.id + (part.id ?? ""),
          name: current.name + (part.name ?? ""),
          arguments: current.arguments + (part.arguments ?? ""),
        })
      }
    }

    const orderedToolCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call)
    return {
      role: "assistant",
      text,
      ...(orderedToolCalls.length ? { toolCalls: orderedToolCalls } : {}),
      ...(usage ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    }
  }

  /** 按模型顺序记录工具调用。 */
  private async recordToolCall(call: ToolCall): Promise<void> {
    if (this.phase.kind !== "running") {
      throw new Error("tool call requires a running phase")
    }

    const execution = Object.freeze({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })
    await this.session.append({ type: "tool/call", data: execution })
    emitSafelyFrom(this.context, this, "tool/call", execution)
  }

  /** 按模型顺序把一个完成结果写入 Session。 */
  private async commitToolResult(
    completion: ToolCompletion<ToolExecutionResult>,
  ): Promise<void> {
    const result = completion.result ?? {
      text: errorMessage(completion.error),
      isError: true,
    }
    await this.session.append({
      type: "tool/result",
      data: {
        role: "tool",
        toolCallId: completion.call.id,
        text: result.text,
        isError: result.isError,
      },
      surfaceOp: "append",
    })
  }

  /** 并发执行安全调用，独占调用形成屏障，结果始终按模型顺序提交。 */
  private async executeToolCalls(calls: readonly ToolCall[]): Promise<void> {
    if (this.phase.kind !== "running") {
      throw new Error("tool calls require a running phase")
    }

    const phase = this.phase
    const committer = createOrderedCommitter<ToolExecutionResult>(
      calls.length,
      (completion) => this.commitToolResult(completion),
    )
    await scheduleToolCalls(calls, {
      maxParallel: this.options.maxParallelTools ?? 4,
      executionMode: (call) => this.toolRegistry.executionMode(call),
      run: (call) => this.toolRegistry.execute(call, {
        signal: phase.abort.signal,
        cwd: this.session.cwd,
      }),
      onDispatch: (call) => this.recordToolCall(call),
      onCompletion: (completion) => committer.accept(completion),
      signal: phase.abort.signal,
    })

    if (committer.committedCount !== calls.length) {
      throw new Error("Not all tool results were committed")
    }
    phase.abort.signal.throwIfAborted()
  }

  /** 执行一个完整 turn，并返回是否还有下一 turn。 */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== "running") {
      throw new Error("agent turn requires a running phase")
    }

    const phase = this.phase
    const turn = phase.turn + 1
    phase.turn = turn
    phase.step = 0
    let reason: TurnEndReason = { kind: "completed" }
    let target: InboxTarget = "next-turn"
    let finished = false

    await this.session.append({ type: "turn/start", data: { turn } })
    emitSafelyFrom(this.context, this, "agent/turn-start", { turn })

    try {
      for (let count = 0; count < (this.options.maxSteps ?? 8); count += 1) {
        phase.abort.signal.throwIfAborted()
        const messages = this.claim(target)
        const step = phase.step + 1
        const decision = await this.context.waterfall(
          this,
          "agent/pre-step",
          { messages, turn, step, signal: phase.abort.signal },
          async (): Promise<PreStepDecision> => ({
            kind: "enter",
            messages,
          }),
        )
        phase.abort.signal.throwIfAborted()

        if (decision.kind === "reject") {
          reason = { kind: "blocked", reason: decision.reason }
          finished = true
          break
        }

        if (count === 0 && decision.messages.length === 0) {
          finished = true
          break
        }

        for (const message of decision.messages) {
          await this.session.append({
            type: "user/message",
            data: message,
            surfaceOp: "append",
          })
        }

        phase.step = step
        await this.session.append({ type: "step/start", data: { turn, step } })
        let result: StepResult
        try {
          result = await this.step()
        } finally {
          await this.session.append({ type: "step/end", data: { turn, step } })
        }

        if (result?.kind === "max-tokens") {
          reason = result
          finished = true
          break
        }
        if (result?.kind === "completed" && this.pending("next-step") === 0) {
          reason = result
          finished = true
          break
        }
        target = "next-step"
      }

      if (!finished) {
        throw new Error(`Agent exceeded maximum steps: ${this.options.maxSteps ?? 8}`)
      }

      return this.pending("next-turn") > 0
    } catch (error) {
      if (phase.abort.signal.aborted) {
        reason = {
          kind: "aborted",
          reason: String(phase.abort.signal.reason ?? "aborted"),
        }
      } else {
        reason = {
          kind: "error",
          error: error instanceof Error ? error.message : String(error),
        }
        emitSafelyFrom(this.context, this, "agent/error", {
          turn,
          step: phase.step,
          error,
        })
      }
      throw error
    } finally {
      await this.session.append({ type: "turn/end", data: { turn, reason } })
      emitSafelyFrom(this.context, this, "agent/turn-end", { turn, reason })
    }
  }

  /** 占用唯一的 driver 槽位。 */
  private reserveDriver(): RunningPhase | undefined {
    if (this.phase.kind !== "idle") return

    const running: RunningPhase = {
      kind: "running",
      abort: new AbortController(),
      turn: this.session.lastTurn(),
      step: 0,
    }
    this.phase = running
    return running
  }

  /** 释放当前 driver，并把状态恢复为空闲。 */
  private releaseDriver(running: RunningPhase): void {
    if (this.phase !== running) return
    this.phase = {
      kind: "idle",
      lastTurn: Math.max(running.turn, this.session.lastTurn()),
    }
  }

  /** 只在 Agent 空闲时启动 driver，并保存可等待的活动 Promise。 */
  /** kick成功则返回resolve否则reject */
  private wakeDriver(): void {
    if (this.phase.kind !== "idle") return

    const running = this.reserveDriver()
    if (running === undefined) return

    const activity = Promise.withResolvers<void>()
    this.activityDone = activity.promise
    void this.kick(running).then(activity.resolve, activity.reject)
  }

  /** 等待当前活动；活动结束时若有新活动，则继续等待。 */
  /** 本质是followup可能多次触发，不能是async，所以需要whenIdle等待agent空闲 */
  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      activity = this.activityDone
      await activity
    } while (activity !== this.activityDone)
  }

  /** 持续执行内部 turn，直到没有下一轮工作（idle）。 */
  private async kick(running: RunningPhase): Promise<void> {
    try {
      while (this.phase === running && await this.turn()) {}
    } catch {
      // turn 已经把错误写入 Session；driver 只负责收敛到 idle。
    } finally {
      this.releaseDriver(running)
      // 旧活动中止时，输入可能在它结束前进入 Inbox；释放后继续处理这些输入。
      if (this.pending() > 0) this.wakeDriver()
    }
  }

}

function readContextWindow(): number {
  const value = Number(process.env.MINI_AGENT_CONTEXT_WINDOW ?? "32768")
  return Number.isSafeInteger(value) && value > 0 ? value : 32768
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error &&
    typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

function formatSummaryTranscript(messages: readonly Message[]): string {
  return messages.map((message) => {
    if (message.role === "user") {
      return `[user]\n${message.text}`
    }

    if (message.role === "assistant") {
      const calls = (message.toolCalls ?? []).map((call) =>
        `[tool call ${call.name} ${call.id}]\n${call.arguments}`,
      )
      return ["[assistant]", message.text, ...calls].filter(Boolean).join("\n")
    }

    return `[tool result ${message.toolCallId}]\n${message.isError ? "Error: " : ""}${message.text}`
  }).join("\n\n")
}
