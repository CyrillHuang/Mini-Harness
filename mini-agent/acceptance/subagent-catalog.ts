import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Session } from "../session/session.js"
import { SessionCatalog } from "../session/catalog.js"
import { SessionStore } from "../session/store.js"
import { sessionPath } from "../session/storage-path.js"

const home = await mkdtemp(join(tmpdir(), "mini-agent-subagent-catalog-"))
const env = { ...process.env, MINI_AGENT_HOME: home }
let parentStore: SessionStore | undefined
let childStore: SessionStore | undefined

try {
  parentStore = new SessionStore(sessionPath("parent", env))
  const parentStoreRef = parentStore!
  const parent = new Session(parentStoreRef, {
    sessionId: "parent",
    sessionName: "Root session",
  })
  parent.bindCwd("/workspace")

  childStore = new SessionStore(sessionPath("child", env))
  const childStoreRef = childStore!
  const child = new Session(childStoreRef, {
    sessionId: "child",
    sessionName: "One-shot child",
    lineage: { parentSession: "parent", delegationDepth: 1 },
  })
  child.bindCwd("/workspace")
  await child.append({
    type: "user/message",
    data: { role: "user", text: "inspect the workspace" },
    surfaceOp: "append",
  })
  await childStoreRef.close()

  await parent.append({
    type: "subagent/catalog",
    data: {
      childSessionId: "child",
      mode: "one-shot",
      name: "One-shot child",
      delegationDepth: 1,
      createdAt: Date.now(),
    },
  })
  await parent.append({
    type: "subagent/settled",
    data: {
      childSessionId: "child",
      stopReason: "completed",
      finishedAt: Date.now(),
    },
  })

  const catalog = new SessionCatalog(env)
  await catalog.register({
    id: "parent",
    name: "Root session",
    cwd: "/workspace",
    delegationDepth: 0,
    filePath: parentStoreRef.filePath,
    createdAt: parent.entries()[0]?.time ?? 0,
    updatedAt: parent.entries().at(-1)?.time ?? 0,
  })

  const roots = await catalog.list("/workspace")
  if (roots.length !== 1 || roots[0]?.id !== "parent") {
    throw new Error("subagent child leaked into the root Session catalog")
  }

  const children = await catalog.listChildren("parent")
  if (children.length !== 1 || children[0]?.id !== "child") {
    throw new Error("child Session could not be discovered through its parent")
  }

  console.log("subagent catalog acceptance passed")
} finally {
  await parentStore?.close()
  await rm(home, { recursive: true, force: true })
}
