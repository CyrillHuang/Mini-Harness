import * as fs from "node:fs"
import { resolve } from "node:path"
import type { Tool } from "../types.js"

export function createReadTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "read",
        description: "Read a UTF-8 text file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    isConcurrencySafe: () => true,
    execute(args, _signal, cwd) {
      const { path } = args as { path: string }
      return fs.readFileSync(resolve(cwd ?? process.cwd(), path), "utf8")
    },
  }
}
