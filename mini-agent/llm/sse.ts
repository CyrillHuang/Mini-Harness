/** 读取 SSE 数据帧；返回值仍是协议层的 data 字符串。 */
export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<string> {
  if (!body) {
    throw new Error("LLM response has no body")
  }

  const reader = body.getReader()
  try {
    const decoder = new TextDecoder()
    let buffer = ""
    let dataLines: string[] = []
    let done = false

    const emitFrame = async function* (): AsyncGenerator<string> {
      if (dataLines.length === 0) return
      const data = dataLines.join("\n")
      dataLines = []
      if (data === "[DONE]") {
        done = true
        return
      }
      yield data
    }

    const consumeLine = async function* (line: string): AsyncGenerator<string> {
      if (line === "") {
        yield* emitFrame()
        return
      }
      if (line.startsWith(":")) return
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart())
      }
    }

    while (!done) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
        stream: !chunk.done,
      })

      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        yield* consumeLine(line)
        if (done) break
        newline = buffer.indexOf("\n")
      }

      if (chunk.done) break
    }

    if (!done) {
      buffer += decoder.decode()
      if (buffer.length > 0) {
        yield* consumeLine(buffer.replace(/\r$/, ""))
      }
      if (dataLines.length > 0 && !done) {
        yield* emitFrame()
      }
    }

    if (!done) {
      throw new Error("LLM SSE stream closed before [DONE]")
    }
  } finally {
    reader.releaseLock()
  }
}
