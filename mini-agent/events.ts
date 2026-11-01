import type { Context } from "@deepseek-ai/cordis"

/** 安全通知观察器；观察器失败只记录警告，不影响主流程。 */
export function emitSafely(
  ctx: Context,
  name: string,
  ...args: unknown[]
): void {
  emitSafelyFrom(ctx, undefined, name, ...args)
}

/** 按 Cordis 服务作用域通知观察器。 */
export function emitSafelyFrom(
  ctx: Context,
  source: object | undefined,
  name: string,
  ...args: unknown[]
): void {
  const dispatchArgs = source === undefined
    ? [name, ...args]
    : [source, name, ...args]
  const callbacks = ctx.events.dispatch("emit", dispatchArgs)
  for (const callback of callbacks) {
    try {
      void Promise.resolve(callback(...args)).catch((error: unknown) => {
        warnObserverFailure(ctx, name, error)
      })
    } catch (error) {
      warnObserverFailure(ctx, name, error)
    }
  }
}

function warnObserverFailure(ctx: Context, name: string, error: unknown): void {
  ctx.logger.warn(`event "${name}" observer failed: ${String(error)}`)
}
