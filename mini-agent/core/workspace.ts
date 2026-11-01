import { realpathSync, statSync, existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs"
import { basename, resolve, join } from "node:path"
import { randomUUID } from "node:crypto"
import { Service, type Context } from "@deepseek-ai/cordis"

declare module "@deepseek-ai/cordis" {
  interface Context {
    workspaceRegistry: WorkspaceRegistry
  }
}

import { agentStateDir } from "../session/storage-path.js"

export type Workspace = Readonly<{
  id: string
  path: string
  title: string
}>

export class WorkspaceRegistry extends Service {
  private readonly records = new Map<string, Workspace>()
  private readonly order: string[] = []

  private readonly file = join(agentStateDir(), "workspaces.json")

  constructor(ctx: Context) {
    super(ctx, "workspaceRegistry")
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { version: number; workspaces: Workspace[] }
      if (saved.version !== 1 || !Array.isArray(saved.workspaces) || saved.workspaces.some(w => typeof w.id !== "string" || typeof w.path !== "string" || typeof w.title !== "string")) throw new Error("Invalid workspace catalog")
      for (const workspace of saved.workspaces) { this.records.set(workspace.id, workspace); this.order.push(workspace.id) }
    }

    ctx.effect(() => {
      return () => {
        this.records.clear()
        this.order.length = 0
      }
    }, "workspaceRegistry in-memory cache")
  }

  create(path: string, title?: string): Workspace {
    const canonicalPath = realpathSync(resolve(path))
    if (!statSync(canonicalPath).isDirectory()) {
      throw new Error(`workspace path is not a directory: ${canonicalPath}`)
    }

    const existing = [...this.records.values()].find(
      (workspace) => workspace.path === canonicalPath,
    )
    if (existing) return existing

    const workspace: Workspace = {
      id: randomUUID(),
      path: canonicalPath,
      title: title ?? basename(canonicalPath),
    }

    this.records.set(workspace.id, workspace)
    this.order.unshift(workspace.id)
    this.persist()
    return workspace
  }

  private persist(): void {
    mkdirSync(agentStateDir(), { recursive: true })
    const temp = this.file + ".tmp"
    writeFileSync(temp, JSON.stringify({ version: 1, workspaces: this.list() }, null, 2))
    renameSync(temp, this.file)
  }

  get(id: string): Workspace | undefined {
    return this.records.get(id)
  }

  list(): Workspace[] {
    return this.order.map((id) => this.records.get(id) as Workspace)
  }
}

export const workspacePlugin = {
  name: "workspace",

  apply(ctx: Context) {
    new WorkspaceRegistry(ctx)
  },
}
