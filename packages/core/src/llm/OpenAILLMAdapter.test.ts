/**
 * Contract tests for OpenAILLMAdapter usage + cache extraction (TER-615 / GAP 4).
 *
 * Two coupled defects this file pins:
 *  1. The adapter streamed with `stream: true` but WITHOUT
 *     `stream_options: { include_usage: true }`, so OpenAI never sent the final
 *     usage chunk → the turn recorded 0 tokens / $0 (same class as the
 *     OpenAI-compatible fix 63e1f031).
 *  2. Per the OpenAI streaming spec the usage chunk has an EMPTY `choices`
 *     array, so it must be read BEFORE the `if (!choice) continue` guard, and
 *     `prompt_tokens_details.cached_tokens` mapped to `cacheReadInputTokens`.
 *
 * Fidelity: the mock emits usage EXACTLY as OpenAI does — on a separate final
 * chunk with `choices: []` (a mock that pigg-backs usage on a choice-bearing
 * chunk would hide the choice-guard bug).
 */

import { describe, expect, it } from "bun:test"
import type { MessageWithParts } from "../session/types"
import { OpenAILLMAdapter } from "./OpenAILLMAdapter"

function makeAdapter(): OpenAILLMAdapter {
  return new OpenAILLMAdapter({ apiKey: "test-key", model: "gpt-4o" })
}

function userMessage(text: string): MessageWithParts {
  return { info: { role: "user" }, parts: [{ type: "text", text }] } as unknown as MessageWithParts
}

/** Minimal async-iterable stream of OpenAI-shaped chunks. */
function streamOf(chunks: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

/** Content chunk (carries a choice). */
const CONTENT = { choices: [{ index: 0, delta: { content: "hola" }, finish_reason: null }] }
/** Finish chunk (carries a choice with finish_reason, empty delta). */
const FINISH = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }

describe("OpenAILLMAdapter — usage + cache extraction (GAP 4)", () => {
  it("asks for stream_options.include_usage — else the turn records 0 tokens", async () => {
    const adapter = makeAdapter()
    let captured: any
    ;(adapter as any).client.chat.completions.create = (params: any) => {
      captured = params
      return streamOf([
        CONTENT,
        FINISH,
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ])
    }

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })

    expect(captured.stream).toBe(true)
    expect(captured.stream_options).toEqual({ include_usage: true })
    // Read from the EMPTY-choices final chunk (proves usage is read before the
    // `if (!choice) continue` guard).
    expect(res.usage?.inputTokens).toBe(100)
    expect(res.usage?.outputTokens).toBe(20)
  })

  it("maps prompt_tokens_details.cached_tokens → cacheReadInputTokens", async () => {
    const adapter = makeAdapter()
    ;(adapter as any).client.chat.completions.create = () =>
      streamOf([
        CONTENT,
        FINISH,
        {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        },
      ])

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })

    // prompt_tokens 100 includes 30 cached → inputTokens is the non-cached 70
    // (A2.1); the two reconstruct the 100-token prompt so cost isn't
    // double-charged. Mutation: drop uncachedInputTokens → inputTokens 100 → red.
    expect(res.usage?.inputTokens).toBe(70)
    expect(res.usage?.cacheReadInputTokens).toBe(30)
    expect((res.usage?.inputTokens ?? 0) + (res.usage?.cacheReadInputTokens ?? 0)).toBe(100)
  })

  it("omits cacheReadInputTokens when the provider reports no cache hit (honest, no 0)", async () => {
    const adapter = makeAdapter()
    ;(adapter as any).client.chat.completions.create = () =>
      streamOf([
        CONTENT,
        FINISH,
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ])

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })

    expect(res.usage).not.toHaveProperty("cacheReadInputTokens")
  })
})
