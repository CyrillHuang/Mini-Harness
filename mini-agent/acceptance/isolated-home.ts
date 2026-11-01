import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "mini-agent-acceptance-"))
process.env.MINI_AGENT_HOME = home
process.once("exit", () => rmSync(home, { recursive: true, force: true }))
