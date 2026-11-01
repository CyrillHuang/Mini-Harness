import {
  createOpenAICompatibleRequest,
  parseOpenAIChunk,
} from "../llm/openai-compatible.js"
import { parseSse } from "../llm/sse.js"

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    },
  })
}

const frames: string[] = []
for await (const data of parseSse(streamFrom([
  ": heartbeat\r\n",
  "data: first\r\n",
  "data: second\r\n\r\n",
  "data: 你\n\n",
  "data: [DONE]\n\n",
]))) {
  frames.push(data)
}

if (frames.join("|") !== "first\nsecond|你") {
  throw new Error(`unexpected SSE frames: ${frames.join("|")}`)
}

const chunk = parseOpenAIChunk(
  '{"choices":[{"index":0,"delta":{"content":"你好"}}]}',
)
if (chunk.choices[0]?.delta.content !== "你好") {
  throw new Error("OpenAI chunk content was not parsed")
}

const summaryRequest = createOpenAICompatibleRequest(
  "test-model",
  [{ role: "user", text: "summarize this" }],
  [],
)
if ("tools" in summaryRequest || "tool_choice" in summaryRequest) {
  throw new Error("requests without tools must omit tool fields")
}

let malformedRejected = false
try {
  parseOpenAIChunk("not json")
} catch {
  malformedRejected = true
}
if (!malformedRejected) throw new Error("malformed JSON was accepted")

let missingDoneRejected = false
try {
  for await (const _data of parseSse(streamFrom(["data: {\"ok\":true}\n\n"]))) {
    // 读取到数据后仍必须检查流结束标记。
  }
} catch {
  missingDoneRejected = true
}
if (!missingDoneRejected) throw new Error("SSE without [DONE] was accepted")

let providerErrorRejected = false
try {
  parseOpenAIChunk('{"error":{"message":"quota exceeded"}}')
} catch (error) {
  providerErrorRejected = String(error).includes("quota exceeded")
}
if (!providerErrorRejected) throw new Error("provider error was not surfaced")

console.log("streaming protocol acceptance passed")
