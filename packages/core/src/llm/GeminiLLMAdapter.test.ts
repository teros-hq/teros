/**
 * Contract tests for GeminiLLMAdapter cache extraction (TER-615 / GAP 4).
 *
 * Gemini reports implicit context-cache hits in
 * `usageMetadata.cachedContentTokenCount`; the adapter read
 * promptTokenCount/candidatesTokenCount but ignored the cache field, so
 * cachedRead stayed 0 for google even though the registry marks it `auto`.
 *
 * Fidelity: the mock emits chunks the way `generateContentStream` does — a
 * content chunk, then a final chunk carrying `finishReason` + `usageMetadata`.
 */

import { describe, expect, it } from "bun:test"
import type { MessageWithParts } from "../session/types"
import { GeminiLLMAdapter } from "./GeminiLLMAdapter"

function makeAdapter(): GeminiLLMAdapter {
  return new GeminiLLMAdapter({ apiKey: "test-key", model: "gemini-2.5-flash" })
}

function userMessage(text: string): MessageWithParts {
  return { info: { role: "user" }, parts: [{ type: "text", text }] } as unknown as MessageWithParts
}

function streamOf(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

const CONTENT = { candidates: [{ content: { parts: [{ text: "hola" }] } }] }

function mockStream(adapter: GeminiLLMAdapter, chunks: any[]): void {
  ;(adapter as any).client.models = {
    generateContentStream: async () => streamOf(chunks),
  }
}

describe("GeminiLLMAdapter — cache extraction (GAP 4)", () => {
  it("maps usageMetadata.cachedContentTokenCount → cacheReadInputTokens", async () => {
    const adapter = makeAdapter()
    mockStream(adapter, [
      CONTENT,
      {
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          cachedContentTokenCount: 40,
        },
      },
    ])

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })

    // promptTokenCount 100 includes 40 cached → inputTokens normalized to the
    // non-cached 60 (A2.1); the two reconstruct the 100-token prompt.
    expect(res.usage?.inputTokens).toBe(60)
    expect(res.usage?.outputTokens).toBe(20)
    expect(res.usage?.cacheReadInputTokens).toBe(40)
    expect((res.usage?.inputTokens ?? 0) + (res.usage?.cacheReadInputTokens ?? 0)).toBe(100)
  })

  it("omits cacheReadInputTokens when there is no cache hit (honest, no 0)", async () => {
    const adapter = makeAdapter()
    mockStream(adapter, [
      CONTENT,
      {
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
      },
    ])

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })

    expect(res.usage).not.toHaveProperty("cacheReadInputTokens")
  })
})

// ---------------------------------------------------------------------------
// TER-707 / CTX-016 — I2-c: signed-part round-trip fidelity across the wire.
// The adapter does NOT run the tool-arg elision itself (that happens
// upstream, in TurnDriver.loadProjectedMessages); these tests pin that the
// adapter faithfully re-emits whatever it's handed — in particular, that a
// signed (E2-exempt) part's huge args travel INTACT with the thoughtSignature
// sibling, since mutating either half of that pair risks a permanent 400.
// ---------------------------------------------------------------------------

function historyMessage(part: {
  callID: string
  input: unknown
  thoughtSignature?: string
}): MessageWithParts {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool: "filesystem_write",
        callID: part.callID,
        state: { status: "completed", input: part.input, output: "ok" },
        ...(part.thoughtSignature && { metadata: { thoughtSignature: part.thoughtSignature } }),
      },
    ],
  } as unknown as MessageWithParts
}

function mockCapturingStream(adapter: GeminiLLMAdapter): { contents(): any } {
  let captured: any
  ;(adapter as any).client.models = {
    generateContentStream: async (req: any) => {
      captured = req.contents
      return streamOf([
        {
          candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      ])
    },
  }
  return { contents: () => captured }
}

describe("GeminiLLMAdapter — TER-707/CTX-016 signed-part round-trip (I2-c)", () => {
  it("a signed part with a huge input reaches the wire INTACT, with its thoughtSignature sibling", async () => {
    const adapter = makeAdapter()
    const captured = mockCapturingStream(adapter)
    const bigInput = { body: "x".repeat(100_000) }

    await adapter.streamMessage({
      messages: [historyMessage({ callID: "call_signed", input: bigInput, thoughtSignature: "sig-xyz" })],
      callbacks: {},
    })

    const modelPart = captured.contents().find((c: any) => c.role === "model").parts[0]
    expect(modelPart.functionCall.args).toEqual(bigInput)
    expect(modelPart.thoughtSignature).toBe("sig-xyz")
  })

  it("an unsigned already-elided part reaches the wire exactly as given — the adapter never re-mutates it", async () => {
    const adapter = makeAdapter()
    const captured = mockCapturingStream(adapter)
    const elidedInput = {
      path: "/a.ts",
      content:
        "y".repeat(2000) +
        "…[system-elided 100000 chars; call already executed — do not re-issue][__terosElided:100000]",
    }

    await adapter.streamMessage({
      messages: [historyMessage({ callID: "call_elided", input: elidedInput })],
      callbacks: {},
    })

    const modelPart = captured.contents().find((c: any) => c.role === "model").parts[0]
    expect(modelPart.functionCall.args).toEqual(elidedInput)
    expect(modelPart.thoughtSignature).toBeUndefined()
  })
})
