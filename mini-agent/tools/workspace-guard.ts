import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Context } from "@deepseek-ai/cordis"

const MODIFY_TOOLS = new Set(["write", "edit"])

/** 阻止修改类文件工具访问当前工作区之外的路径。 */
export const workspaceGuardPlugin = {
  name: "workspace-guard",
  inject: ["toolRegistry"],

  apply(ctx: Context) {
    ctx.effect(() => {
      const dispose = ctx.toolRegistry.registerGuard((execution) => {
        if (!execution.cwd || !MODIFY_TOOLS.has(execution.name)) return undefined

        let path: unknown
        try {
          path = (JSON.parse(execution.arguments) as { path?: unknown }).path
        } catch {
          return "Invalid tool arguments."
        }
        if (typeof path !== "string") return undefined

        const target = resolve(execution.cwd, path)
        const outside = relative(execution.cwd, target)
        if (
          outside === ".."
          || outside.startsWith(`..${sep}`)
          || isAbsolute(outside)
        ) {
          return "File path is outside the workspace."
        }

        return undefined
      })

      return dispose
    }, "workspace guard")
  },
}
