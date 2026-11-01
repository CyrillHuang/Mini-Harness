import type { ToolCall } from "../types.js"

export type ToolExecutionMode = "parallel" | "exclusive"

export type ToolCompletion<Result> =
  | { index: number; call: ToolCall; result: Result; error?: never }
  | { index: number; call: ToolCall; result?: never; error: unknown }

export const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH"

type SchedulerOptions<Result> = {
  maxParallel: number
  executionMode(call: ToolCall): ToolExecutionMode
  run(call: ToolCall): Promise<Result>
  onDispatch?(call: ToolCall): void | Promise<void>
  onCompletion(completion: ToolCompletion<Result>): void | Promise<void>
  signal?: AbortSignal
}

/** 按并发声明调度工具；独占调用会等待前后的并发组结束。 */
export async function scheduleToolCalls<Result>(
  calls: readonly ToolCall[],
  options: SchedulerOptions<Result>,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxParallel) || options.maxParallel < 1) {
    throw new Error("maxParallel must be a positive integer")
  }

  let nextIndex = 0
  while (nextIndex < calls.length && !options.signal?.aborted) {
    const first = calls[nextIndex]
    if (!first) break

    if (options.executionMode(first) === "exclusive") {
      await options.onDispatch?.(first)
      const completion = await runCall(nextIndex, first, options.run)
      await options.onCompletion(completion)
      nextIndex += 1
      continue
    }

    const inFlight = new Map<number, Promise<ToolCompletion<Result>>>()
    const fillPool = async () => {
      while (
        nextIndex < calls.length &&
        inFlight.size < options.maxParallel &&
        !options.signal?.aborted
      ) {
        const call = calls[nextIndex]
        if (!call || options.executionMode(call) !== "parallel") break

        const index = nextIndex
        nextIndex += 1
        await options.onDispatch?.(call)
        inFlight.set(index, runCall(index, call, options.run))
      }
    }

    await fillPool()
    while (inFlight.size > 0) {
      const completion = await Promise.race(inFlight.values())
      inFlight.delete(completion.index)
      await options.onCompletion(completion)
      await fillPool()
    }
  }

  while (nextIndex < calls.length) {
    const call = calls[nextIndex]
    if (!call) break
    await options.onDispatch?.(call)
    await options.onCompletion({
      index: nextIndex,
      call,
      error: {
        name: "AbortError",
        code: TOOL_ABORTED_BEFORE_DISPATCH,
        message: "tool call aborted before dispatch",
      },
    })
    nextIndex += 1
  }
}

/** 接受乱序结果，只按模型原始顺序执行持久化提交。 */
export function createOrderedCommitter<Result>(
  length: number,
  commit: (completion: ToolCompletion<Result>) => void | Promise<void>,
) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("length must be a non-negative integer")
  }

  const slots: Array<ToolCompletion<Result> | undefined> = []
  let cursor = 0

  return {
    async accept(completion: ToolCompletion<Result>): Promise<void> {
      if (!Number.isSafeInteger(completion.index) ||
        completion.index < 0 || completion.index >= length) {
        throw new Error(`Invalid completion index: ${completion.index}`)
      }
      if (slots[completion.index] !== undefined) {
        throw new Error(`Duplicate completion index: ${completion.index}`)
      }

      slots[completion.index] = completion
      while (cursor < length) {
        const next = slots[cursor]
        if (!next) break
        await commit(next)
        cursor += 1
      }
    },

    get committedCount(): number {
      return cursor
    },
  }
}

function runCall<Result>(
  index: number,
  call: ToolCall,
  run: (call: ToolCall) => Promise<Result>,
): Promise<ToolCompletion<Result>> {
  return Promise.resolve()
    .then(() => run(call))
    .then(
      (result) => ({ index, call, result }),
      (error) => ({ index, call, error }),
    )
}
