import * as fs from "node:fs"
import { resolve } from "node:path"
import type { Tool } from "../types.js"

export function createWriteTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "write",
        description: "Write UTF-8 text to a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            content: { type: "string", description: "Text to write" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    execute(args, _signal, cwd) {
      const { path, content } = args as { path: string; content: string }
      fs.writeFileSync(resolve(cwd ?? process.cwd(), path), content, "utf8")
      return "ok"
    },
  }
}
