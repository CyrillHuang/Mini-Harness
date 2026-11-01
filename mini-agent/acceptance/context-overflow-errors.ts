import {
  callOpenAICompatibleModel,
  parseOpenAIChunk,
  streamOpenAICompatibleModel,
} from "../llm/openai-compatible.js"
import {
  isContextWindowExceededError,
  type LlmRequestError,
} from "../llm/errors.js"

const connection = { baseUrl: "https://provider.invalid", apiKey: "test-key" }
const request = { model: "test-model", messages: [], tools: [] }
const originalFetch = globalThis.fetch

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function assertContextOverflow(error: unknown, label: string): void {
  if (!(error instanceof Error) || !("code" in error)) {
    throw new Error(`${label}: expected a structured LLM error`)
  }
  if ((error as LlmRequestError).code !== "CONTEXT_WINDOW_EXCEEDED") {
    throw new Error(`${label}: got ${(error as LlmRequestError).code}`)
  }
}

async function expectReject(
  operation: () => Promise<unknown>,
  check: (error: unknown) => void,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    check(error)
    return
  }
  throw new Error("expected operation to reject")
}

try {
  if (!isContextWindowExceededError("maximum context length is 128k")) {
    throw new Error("structured context wording was not recognized")
  }
  if (isContextWindowExceededError("invalid request")) {
    throw new Error("ordinary request wording was misclassified")
  }

  globalThis.fetch = async () => response({
    error: {
      type: "invalid_request_error",
      message: "maximum context length is 128k",
    },
  }, 400)
  await expectReject(
    () => callOpenAICompatibleModel(connection, request),
    (error) => assertContextOverflow(error, "non-stream context overflow"),
  )

  globalThis.fetch = async () => response({
    error: { type: "invalid_request_error", message: "invalid JSON body" },
  }, 400)
  await expectReject(
    () => callOpenAICompatibleModel(connection, request),
    (error) => {
      if (!(error instanceof Error) || (error as LlmRequestError).code === "CONTEXT_WINDOW_EXCEEDED") {
        throw new Error("ordinary 400 was treated as context overflow")
      }
    },
  )

  for (const status of [413, 429, 500]) {
    globalThis.fetch = async () => response({
      error: {
        type: "provider_error",
        message: "maximum context length exceeded",
      },
    }, status)
    await expectReject(
      () => callOpenAICompatibleModel(connection, request),
      (error) => {
        if (!(error instanceof Error) || (error as LlmRequestError).code === "CONTEXT_WINDOW_EXCEEDED") {
          throw new Error(`HTTP ${status} was treated as context overflow`)
        }
      },
    )
  }

  globalThis.fetch = async () => response({
    error: { type: "authentication_error", message: "invalid API key" },
  }, 401)
  await expectReject(
    () => callOpenAICompatibleModel(connection, request),
    (error) => {
      if (!(error instanceof Error) || (error as LlmRequestError).code !== "AUTHENTICATION") {
        throw new Error("authentication error was not classified")
      }
    },
  )

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed")
  }
  await expectReject(
    () => callOpenAICompatibleModel(connection, request),
    (error) => {
      if (!(error instanceof Error) || (error as LlmRequestError).code !== "NETWORK") {
        throw new Error("network error was not classified")
      }
    },
  )

  const line = JSON.stringify({
    error: {
      type: "invalid_request_error",
      message: "prompt is too long for the model context",
    },
  })
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${line}\n\n`))
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
  await expectReject(
    async () => {
      for await (const _chunk of streamOpenAICompatibleModel(connection, request)) {
        // The provider error is expected before a usable chunk is yielded.
      }
    },
    (error) => assertContextOverflow(error, "stream context overflow"),
  )

  // Provider error frames are normalized before the OpenAI chunk reaches an adapter.
  assertContextOverflow(
    (() => {
      try {
        parseOpenAIChunk(`{"error":{"message":"maximum context window exceeded"}}`)
      } catch (error) {
        return error
      }
      return undefined
    })(),
    "in-band OpenAI error",
  )

  console.log("context overflow error acceptance passed")
} finally {
  globalThis.fetch = originalFetch
}
