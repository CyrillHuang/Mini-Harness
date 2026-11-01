import type { Context } from "@deepseek-ai/cordis"
import { PromptService, type PromptOptions } from "./service.js"

/** 提供独立的提示词组装服务。工具接入由 ToolRegistry 后续完成。 */
export const promptPlugin = {
  name: "prompt",

  apply(ctx: Context, options: PromptOptions = {}) {
    new PromptService(ctx, options)
  },
}
