import type { Context } from "@deepseek-ai/cordis"

export class PetPlugin {
  static inject = ["gui"]
  constructor(ctx: Context, config: { size?: number; fps?: number } = {}) {
    const size = config.size ?? 96, fps = config.fps ?? 8
    if (!Number.isFinite(size) || size < 48 || size > 192 || !Number.isFinite(fps) || fps < 1 || fps > 24) throw new Error("Invalid pet configuration")
    ctx.effect(() => {
      ctx.gui.petConfig = { size, fps }
      return () => { ctx.gui.petConfig = undefined }
    })
  }
}
