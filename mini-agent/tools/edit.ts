import * as fs from "node:fs"
import { resolve } from "node:path"
import type { Tool } from "../types.js"

export function createEditTool(): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "edit",
        description: "Replace one exact piece of text in a UTF-8 file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            oldText: { type: "string", description: "Exact text to replace" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    execute(args, _signal, cwd) {
      const { path, oldText, newText } = args as {
        path: string
        oldText: string
        newText: string
      }
      const filePath = resolve(cwd ?? process.cwd(), path)
      const content = fs.readFileSync(filePath, "utf8")
      const occurrences = content.split(oldText).length - 1
      if (occurrences !== 1) {
        throw new Error(`edit expected exactly one match, found ${occurrences}`)
      }

      fs.writeFileSync(filePath, content.replace(oldText, newText), "utf8")
      return "ok"
    },
  }
}
