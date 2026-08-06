/**
 * Tests for the OpenAI-compatible adapter instrumentation (TER-615 / F0).
 *
 * Two surfaces:
 *  1. Error classification — `teros`/Fireworks 429 and 503 used to collapse into
 *     the generic catch-all; they must now produce distinguishable `errorClass`
 *     buckets, and Together's body-level `dynamic_request_limited` /
 *     `dynamic_token_limited` must classify as rate_limited even off a 429.
 *  2. Measurement — TTFT/latency, cached + reasoning token extraction, the
 *     onUsage/onFinish hooks, and the `actualProvider` tag (gap C1).
 *
 * Fidelity: provider errors are built with `OpenAI.APIError.generate()`, exactly
 * how the SDK constructs them when it parses a real `{ error: { message, type } }`
 * body — so `error.type`/`error.code` are lifted the same way as in production.
 */

import { describe, expect, it } from "bun:test"
import OpenAI from "openai"
import { LLMError } from "../errors/AgentError"
import type { MessageWithParts } from "../session/types"
import { OpenAICompatibleLLMAdapter } from "./OpenAICompatibleLLMAdapter"

function makeAdapter(actualProvider?: string): OpenAICompatibleLLMAdapter {
  return new OpenAICompatibleLLMAdapter({
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/kimi-k2p6",
    apiKey: "test-key",
    actualProvider,
  })
}

/**
 * Build an OpenAI APIError as the SDK does when it parses a provider error body
 * `{ error: { message, type } }`. `generate` lifts `body.error.{type,code}` onto
 * the error instance — the same path Fireworks/Together responses take.
 */
function makeApiError(
  status: number,
  body: { message?: string; type?: string; code?: string },
  headers?: Record<string, string>,
): OpenAI.APIError {
  return OpenAI.APIError.generate(
    status,
    { error: body },
    body.message,
    new Headers(headers ?? {}),
  ) as OpenAI.APIError
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

/** Replace the SDK call with a fake `create().withResponse()` returning `data`+`response`. */
function stubStream(
  adapter: OpenAICompatibleLLMAdapter,
  chunks: any[],
  responseHeaders?: Record<string, string>,
): void {
  ;(adapter as any).client.chat.completions.create = () => ({
    withResponse: async () => ({
      data: streamOf(chunks),
      response: { headers: new Headers(responseHeaders ?? {}) },
      request_id: "req_test",
    }),
  })
}

describe("OpenAICompatibleLLMAdapter — classifyErrorClass (TER-615)", () => {
  it("classifies Fireworks 429 as rate_limited", () => {
    const adapter = makeAdapter("fireworks")
    const err = makeApiError(429, { message: "rate limit", type: "rate_limit_exceeded" })
    expect((adapter as any).classifyErrorClass(err)).toBe("rate_limited")
  })

  it("classifies Together dynamic_request_limited as rate_limited regardless of HTTP status", () => {
    const adapter = makeAdapter("together")
    // Together can surface this on a non-429 status — classify by body type first.
    const err = makeApiError(400, { message: "dynamic", type: "dynamic_request_limited" })
    expect((adapter as any).classifyErrorClass(err)).toBe("rate_limited")
  })

  it("classifies Together dynamic_token_limited as rate_limited", () => {
    const adapter = makeAdapter("together")
    const err = makeApiError(429, { message: "tokens", type: "dynamic_token_limited" })
    expect((adapter as any).classifyErrorClass(err)).toBe("rate_limited")
  })

  it("separates 503 (overloaded) from other 5xx (server_error)", () => {
    const adapter = makeAdapter("fireworks")
    expect((adapter as any).classifyErrorClass(makeApiError(503, { message: "overloaded" }))).toBe(
      "overloaded",
    )
    expect((adapter as any).classifyErrorClass(makeApiError(500, { message: "boom" }))).toBe(
      "server_error",
    )
    expect((adapter as any).classifyErrorClass(makeApiError(502, { message: "bad gw" }))).toBe(
      "server_error",
    )
    expect((adapter as any).classifyErrorClass(makeApiError(529, { message: "overloaded" }))).toBe(
      "server_error",
    )
  })

  it("classifies 402 as spend_gate, 401/403 as auth, 404 as not_found", () => {
    const adapter = makeAdapter("together")
    expect((adapter as any).classifyErrorClass(makeApiError(402, { message: "no funds" }))).toBe(
      "spend_gate",
    )
    expect((adapter as any).classifyErrorClass(makeApiError(401, { message: "x" }))).toBe("auth")
    expect((adapter as any).classifyErrorClass(makeApiError(403, { message: "x" }))).toBe("auth")
    expect((adapter as any).classifyErrorClass(makeApiError(404, { message: "x" }))).toBe(
      "not_found",
    )
  })

  it("classifies socket-level connection errors", () => {
    const adapter = makeAdapter("fireworks")
    const econn = Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
    const edns = Object.assign(new Error("dns"), { code: "ENOTFOUND" })
    expect((adapter as any).classifyErrorClass(econn)).toBe("connection")
    expect((adapter as any).classifyErrorClass(edns)).toBe("connection")
  })

  it("returns undefined for unclassified errors", () => {
    const adapter = makeAdapter("fireworks")
    expect((adapter as any).classifyErrorClass(new Error("weird"))).toBeUndefined()
    expect(
      (adapter as any).classifyErrorClass(makeApiError(418, { message: "teapot" })),
    ).toBeUndefined()
  })
})

describe("OpenAICompatibleLLMAdapter — classifyErrorSubReason (TER-698)", () => {
  const sub = (adapter: OpenAICompatibleLLMAdapter, e: unknown) =>
    (adapter as any).classifyErrorSubReason(e) as string | undefined

  it("429 generic Fireworks body → provider_capacity (deployment saturation, Teros-side)", () => {
    const a = makeAdapter("fireworks")
    expect(sub(a, makeApiError(429, { message: "rate limit exceeded, please try again later" }))).toBe(
      "provider_capacity",
    )
  })

  it("429 that names an RPM/TPM cap → account/token rate-limit (only on explicit mention)", () => {
    const a = makeAdapter("fireworks")
    expect(sub(a, makeApiError(429, { message: "requests per minute limit reached" }))).toBe(
      "account_rate_limit",
    )
    expect(sub(a, makeApiError(429, { message: "TPM exceeded for this account" }))).toBe(
      "token_rate_limit",
    )
  })

  it("Together dynamic body types → account/token rate-limit regardless of status", () => {
    const a = makeAdapter("together")
    expect(sub(a, makeApiError(400, { message: "x", type: "dynamic_request_limited" }))).toBe(
      "account_rate_limit",
    )
    expect(sub(a, makeApiError(429, { message: "x", type: "dynamic_token_limited" }))).toBe(
      "token_rate_limit",
    )
  })

  it("maps 402/404/503/5xx/auth to their persistent sub-reasons", () => {
    const a = makeAdapter("fireworks")
    expect(sub(a, makeApiError(402, { message: "no funds" }))).toBe("provider_billing")
    expect(sub(a, makeApiError(404, { message: "gone" }))).toBe("model_unavailable")
    expect(sub(a, makeApiError(503, { message: "busy" }))).toBe("provider_overloaded")
    for (const s of [500, 502, 504, 524, 529]) {
      expect(sub(a, makeApiError(s, { message: "boom" }))).toBe("provider_server_error")
    }
    expect(sub(a, makeApiError(401, { message: "x" }))).toBe("auth")
    expect(sub(a, makeApiError(403, { message: "x" }))).toBe("auth")
  })

  it("returns undefined for non-APIError and unmapped statuses", () => {
    const a = makeAdapter("fireworks")
    expect(sub(a, new Error("weird"))).toBeUndefined()
    expect(sub(a, Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBeUndefined()
    expect(sub(a, makeApiError(418, { message: "teapot" }))).toBeUndefined()
  })
})

describe("OpenAICompatibleLLMAdapter — createLLMError context payload (TER-615)", () => {
  it("429 Fireworks → exact rate-limit context with errorClass + source, honoring retry-after", () => {
    const adapter = makeAdapter("fireworks")
    const err = makeApiError(
      429,
      { message: "slow down", type: "rate_limit_exceeded" },
      { "retry-after": "30" },
    )
    const llmError = (adapter as any).createLLMError(err, { baseUrl: "u", model: "m" }) as LLMError
    expect(llmError).toBeInstanceOf(LLMError)

    // Assert the EXACT payload (minus the Date.now()-dependent resetAt and the
    // SDK-composed upstreamMessage, both asserted separately below).
    const { resetAt, upstreamMessage, ...rest } = llmError.context
    expect(rest).toEqual({
      baseUrl: "u",
      model: "m",
      errorClass: "rate_limited",
      errorSubReason: "provider_capacity",
      isRateLimit: true,
      retryAfterSecs: 30,
      retryAfterMs: 30000,
      source: "Fireworks",
      rateLimitType: "rate_limit_exceeded",
    })
    expect(typeof resetAt).toBe("number")
    // The literal upstream text is preserved verbatim (the SDK's message), never
    // overwritten with our copy (TER-222).
    expect(upstreamMessage).toBe(err.message)
    expect(upstreamMessage).toContain("slow down")
  })

  it("Together dynamic_request_limited → rate_limited + rateLimitType + source Together", () => {
    const adapter = makeAdapter("together")
    const err = makeApiError(429, { message: "dyn", type: "dynamic_request_limited" })
    const llmError = (adapter as any).createLLMError(err, {}) as LLMError
    expect(llmError.context.errorClass).toBe("rate_limited")
    expect(llmError.context.errorSubReason).toBe("account_rate_limit")
    expect(llmError.context.isRateLimit).toBe(true)
    expect(llmError.context.rateLimitType).toBe("dynamic_request_limited")
    expect(llmError.context.source).toBe("Together")
    expect(llmError.context.upstreamMessage).toBe(err.message)
    // retry-after absent → time fields undefined but still flagged.
    expect(llmError.context.retryAfterSecs).toBeUndefined()
    expect(llmError.message).toContain("dynamic_request_limited")
  })

  it("503 → overloaded errorClass + provider_overloaded sub-reason, NOT flagged as rate limit", () => {
    const adapter = makeAdapter("fireworks")
    const err = makeApiError(503, { message: "overloaded" })
    const llmError = (adapter as any).createLLMError(err, {}) as LLMError
    expect(llmError.context.errorClass).toBe("overloaded")
    expect(llmError.context.errorSubReason).toBe("provider_overloaded")
    expect(llmError.userMessage.toLowerCase()).toContain("overloaded")
    expect(llmError.context.isRateLimit).toBeUndefined()
  })

  it("402 → spend_gate + provider_billing sub-reason, upstream preserved", () => {
    const adapter = makeAdapter("fireworks")
    const err = makeApiError(402, { message: "account not on paid plan or exceeded usage limits" })
    const llmError = (adapter as any).createLLMError(err, {}) as LLMError
    expect(llmError.context.errorClass).toBe("spend_gate")
    expect(llmError.context.errorSubReason).toBe("provider_billing")
    expect(llmError.context.upstreamMessage).toContain(
      "account not on paid plan or exceeded usage limits",
    )
  })

  it("404 → not_found + model_unavailable sub-reason", () => {
    const adapter = makeAdapter("fireworks")
    const err = makeApiError(404, { message: "model glm-5p2 not found or not deployed" })
    const llmError = (adapter as any).createLLMError(err, {}) as LLMError
    expect(llmError.context.errorClass).toBe("not_found")
    expect(llmError.context.errorSubReason).toBe("model_unavailable")
  })

  it("generic provider label when actualProvider is the generic openai-compatible default", () => {
    const adapter = makeAdapter() // default 'openai-compatible'
    const err = makeApiError(500, { message: "boom" })
    const llmError = (adapter as any).createLLMError(err, {}) as LLMError
    expect(llmError.context.errorClass).toBe("server_error")
    expect(llmError.context.errorSubReason).toBe("provider_server_error")
    expect(llmError.message).toContain("The AI service")
  })
})

describe("OpenAICompatibleLLMAdapter — measurement & hooks (TER-615)", () => {
  it("measures TTFT/latency, reads cached+reasoning, emits onUsage/onFinish, tags actualProvider", async () => {
    const adapter = makeAdapter("together")
    const chunks = [
      { id: "cmpl-xyz", choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { id: "cmpl-xyz", choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
      // FAITHFUL boundary shape: with stream_options.include_usage the usage
      // arrives in a FINAL chunk whose `choices` is EMPTY (OpenAI spec). The
      // previous mock put usage on a chunk WITH a choice, which is why the
      // suite stayed green while production skipped the real usage chunk
      // behind `if (!choice) continue` and recorded 0 tokens (P3, 2026-07-07).
      {
        id: "cmpl-xyz",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 64 },
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
    ]
    stubStream(adapter, chunks, { "fireworks-server-time-to-first-token": "0.25" })

    let usageCb: any
    let finishCb: any
    const texts: string[] = []
    const res = await adapter.streamMessage({
      messages: [userMessage("hi")],
      callbacks: {
        onText: (t) => {
          texts.push(t)
        },
        onUsage: (u) => {
          usageCb = u
        },
        onFinish: (f) => {
          finishCb = f
        },
      },
    })

    // Return value: exact usage (C4 cached + Together reasoning). prompt_tokens
    // was 100 with 64 cached → inputTokens is normalized to the NON-cached 36
    // (A2.1); the two reconstruct the full 100-token prompt. Mutation: drop the
    // `uncachedInputTokens` call → inputTokens 100 → the cached tokens get
    // double-charged in cost → red.
    expect(res.usage).toEqual({
      inputTokens: 36,
      outputTokens: 20,
      cacheReadInputTokens: 64,
      reasoningTokens: 12,
    })
    expect((res.usage!.inputTokens ?? 0) + (res.usage!.cacheReadInputTokens ?? 0)).toBe(100)
    expect(res.metadata?.actualProvider).toBe("together")
    expect(res.metadata?.serverTtftMs).toBe(250) // 0.25s header → ms
    expect(res.metadata?.id).toBe("cmpl-xyz")
    expect(typeof res.metadata?.ttftMs).toBe("number")
    expect(typeof res.metadata?.latencyMs).toBe("number")
    expect(res.metadata?.latencyMs).toBeGreaterThanOrEqual(res.metadata?.ttftMs)

    // onUsage carries the exact token payload (non-cached input).
    expect(usageCb).toEqual({
      inputTokens: 36,
      outputTokens: 20,
      cacheReadInputTokens: 64,
      reasoningTokens: 12,
    })
    // onFinish carries timing + classification (no error on success).
    expect(finishCb.actualProvider).toBe("together")
    expect(finishCb.serverTtftMs).toBe(250)
    expect(finishCb.finishReason).toBe("stop")
    expect(finishCb.errorClass).toBeUndefined()
    expect(typeof finishCb.latencyMs).toBe("number")

    expect(texts.join("")).toBe("Hello")
  })

  it("forwards reasoning_content to onThinking as a stall-watchdog heartbeat, not to onText (TER-650)", async () => {
    // A reasoning model streams reasoning_content before any visible token.
    // TurnDriver maps onThinking → the stall watchdog's progress signal, so a
    // long reasoning block must reach onThinking (else it reads as a frozen
    // socket and the turn is wrongly killed as a timeout). It must NOT reach
    // onText — reasoning is not part of the assistant reply.
    const adapter = makeAdapter("fireworks")
    const chunks = [
      { id: "c1", choices: [{ delta: { reasoning_content: "let me " }, finish_reason: null }] },
      { id: "c1", choices: [{ delta: { reasoning_content: "think" }, finish_reason: null }] },
      {
        id: "c1",
        choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ]
    stubStream(adapter, chunks)

    const thinking: string[] = []
    const texts: string[] = []
    await adapter.streamMessage({
      messages: [userMessage("hi")],
      callbacks: {
        onThinking: (t) => {
          thinking.push(t)
        },
        onText: (t) => {
          texts.push(t)
        },
      },
    })

    // Every reasoning delta reached onThinking (drop the wiring → []).
    expect(thinking).toEqual(["let me ", "think"])
    // …and none of it leaked into the visible assistant text.
    expect(texts.join("")).toBe("Answer")
  })

  it("surfaces tool-call argument deltas to onToolInputDelta as a stall-watchdog heartbeat (TER-650)", async () => {
    // Tool input is buffered until the stream ends (onToolCall fires last), so
    // while the model writes large tool arguments these deltas are the ONLY
    // liveness signal. Drop the wiring → the stall guard reads a productive
    // stream as a frozen socket and kills it ("llm-stream timed out").
    const adapter = makeAdapter("fireworks")
    const chunks = [
      {
        id: "c1",
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "search", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c1",
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: "c1",
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"hola"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
    ]
    stubStream(adapter, chunks)

    const inputDeltas: string[] = []
    const toolCalls: any[] = []
    await adapter.streamMessage({
      messages: [userMessage("hi")],
      callbacks: {
        onToolInputDelta: (d) => {
          inputDeltas.push(d)
        },
        onToolCall: (tc) => {
          toolCalls.push(tc)
        },
      },
    })

    // Every tool-call delta produced a heartbeat (the name/id-only first delta
    // counts too — it is still stream progress).
    expect(inputDeltas).toEqual(["", '{"query":', '"hola"}'])
    // The assembled call still arrives exactly once, unchanged.
    expect(toolCalls).toEqual([{ id: "call_1", name: "search", input: { query: "hola" } }])
  })

  it("asks for usage in the stream (stream_options.include_usage) — else the default model records 0 tokens/$0", async () => {
    const adapter = makeAdapter("fireworks")
    let captured: any
    ;(adapter as any).client.chat.completions.create = (params: any) => {
      captured = params
      return {
        withResponse: async () => ({
          data: streamOf([
            { id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
            // Spec shape: the flag-produced usage chunk carries NO choices.
            { id: "c1", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
          ]),
          response: { headers: new Headers() },
          request_id: "req_test",
        }),
      }
    }
    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })
    // The exact flag that makes OpenAI-compatible streaming emit the final usage
    // chunk. Without it, `chunk.usage` never arrives and tokens/cost stay 0.
    expect(captured.stream).toBe(true)
    expect(captured.stream_options).toEqual({ include_usage: true })
    // With it, tokens are recorded (not the 0/0 the bug produced).
    expect(res.usage.inputTokens).toBe(7)
    expect(res.usage.outputTokens).toBe(3)
  })

  it("omits cached/reasoning + serverTtft when the provider does not report them (honest fields)", async () => {
    const adapter = makeAdapter("fireworks")
    const chunks = [
      { id: "c1", choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }], usage: null },
      { id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]
    stubStream(adapter, chunks) // no perf header

    const res = await adapter.streamMessage({ messages: [userMessage("hi")], callbacks: {} })
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 })
    expect(res.metadata?.serverTtftMs).toBeUndefined()
    expect(res.metadata?.actualProvider).toBe("fireworks")
  })

  it("emits onFinish with errorClass on failure, then re-throws the classified LLMError", async () => {
    const adapter = makeAdapter("fireworks")
    const apiErr = makeApiError(
      429,
      { message: "slow", type: "rate_limit_exceeded" },
      { "retry-after": "10" },
    )
    ;(adapter as any).client.chat.completions.create = () => ({
      withResponse: async () => {
        throw apiErr
      },
    })

    let finishCb: any
    let thrown: unknown
    try {
      await adapter.streamMessage({
        messages: [userMessage("hi")],
        callbacks: {
          onFinish: (f) => {
            finishCb = f
          },
        },
      })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(LLMError)
    expect((thrown as LLMError).context.errorClass).toBe("rate_limited")
    expect(finishCb).toBeDefined()
    expect(finishCb.errorClass).toBe("rate_limited")
    expect(finishCb.actualProvider).toBe("fireworks")
    expect(typeof finishCb.latencyMs).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// TER-707 / CTX-016 — I2-a/b: an already-projected (elided) tool input still
// serializes as valid JSON in `function.arguments`, and the tool_call ↔
// tool_result pair survives on the wire by the SAME callID. The adapter does
// NOT run the elision itself (upstream, TurnDriver.loadProjectedMessages) —
// this pins that it doesn't need to: a plain stringify is enough once the
// value it's handed is already bounded.
// ---------------------------------------------------------------------------

describe("OpenAICompatibleLLMAdapter — TER-707/CTX-016 request-shape after projection (I2-a/b)", () => {
  it("an elided tool input round-trips as valid JSON; callID pairs the call and its result", async () => {
    const adapter = makeAdapter()
    let capturedReq: any
    ;(adapter as any).client.chat.completions.create = (req: any) => {
      capturedReq = req
      return {
        withResponse: async () => ({
          data: streamOf([{ id: "c1", choices: [{ delta: {}, finish_reason: "stop" }], usage: null }]),
          response: { headers: new Headers() },
          request_id: "req_test",
        }),
      }
    }

    const elidedInput = {
      path: "/a.ts",
      content:
        "y".repeat(2000) +
        "…[system-elided 100000 chars; call already executed — do not re-issue][__terosElided:100000]",
    }
    const history: MessageWithParts = {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "filesystem_write",
          callID: "call_a",
          state: { status: "completed", input: elidedInput, output: "ok" },
        },
      ],
    } as unknown as MessageWithParts

    await adapter.streamMessage({ messages: [history], callbacks: {} })

    const assistantMsg = capturedReq.messages.find((m: any) => m.role === "assistant" && m.tool_calls)
    expect(assistantMsg).toBeDefined()
    const toolCall = assistantMsg.tool_calls[0]
    expect(toolCall.id).toBe("call_a")
    expect(() => JSON.parse(toolCall.function.arguments)).not.toThrow()
    expect(JSON.parse(toolCall.function.arguments)).toEqual(elidedInput)

    const toolResultMsg = capturedReq.messages.find((m: any) => m.role === "tool")
    expect(toolResultMsg.tool_call_id).toBe("call_a")
  })
})
