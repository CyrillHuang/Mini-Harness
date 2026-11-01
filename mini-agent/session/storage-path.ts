import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

/** 返回 Agent 的用户级状态目录。 */
export function agentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MINI_AGENT_HOME?.trim()
  if (override) return resolve(override)

  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? homedir(), "mini-agent")
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "mini-agent")
  }

  const stateHome = env.XDG_STATE_HOME?.trim()
  return join(
    stateHome && isAbsolute(stateHome)
      ? stateHome
      : join(homedir(), ".local", "state"),
    "mini-agent",
  )
}

/** 返回指定 Session 的 JSONL 文件路径。 */
export function sessionPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("session id contains invalid characters")
  }
  return join(agentStateDir(env), "sessions", `${sessionId}.jsonl`)
}

/** 返回 Session 文件所在目录。 */
export function sessionsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(agentStateDir(env), "sessions")
}

/** 返回 Session Catalog 文件路径。 */
export function sessionCatalogPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(agentStateDir(env), "catalog.json")
}
