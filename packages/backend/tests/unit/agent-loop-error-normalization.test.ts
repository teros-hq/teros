/**
 * handleAgentError — verifica que errores crudos se normalizan a mensajes
 * usuario-friendly y que AgentError instances se preservan.
 */

import { describe, expect, it, mock } from "bun:test"
import {
  AgentError,
  LLMError,
  NetworkError,
  OpenAICompatibleLLMAdapter,
  SessionError,
  ToolError,
} from "@teros/core"
import OpenAI from "openai"
import { handleAgentError } from "../../src/handlers/message/agent-loop"

function makeCtx() {
  const saved: any[] = []
  const broadcast: any[] = []

  return {
    ctx: {
      db: {} as any,
      channelManager: {
        createMessageId: () => `msg-${Date.now()}`,
        saveMessage: mock((m: any) => {
          saved.push(m)
          return Promise.resolve()
        }),
      },
      usageService: {} as any,
      usageTrackingService: {} as any,
      agentUsageSessionService: null,
      broadcastToChannel: mock((_ch: string, m: any) => {
        broadcast.push(m)
      }),
      broadcastChannelListStatus: mock(() => Promise.resolve()),
      broadcastChannelStatus: mock(() => {}),
      maybeAutonameChannel: mock(() => Promise.resolve()),
    } as any,
    saved,
    broadcast,
  }
}

function contentOf(broadcast: any[]) {
  return broadcast[0]?.message?.content
}

// ---------------------------------------------------------------------------
// Raw errors → normalized user messages
// ---------------------------------------------------------------------------

describe("handleAgentError — raw error normalization", () => {
  it("ECONNREFUSED on 27017 → database connection message", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("connect ECONNREFUSED ::1:27017"))
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("network")
    expect(c.userMessage).not.toContain("ECONNREFUSED")
    expect(c.userMessage).not.toContain("27017")
    expect(c.context.recoverable).toBe(true)
  })

  it("ECONNRESET → connection interrupted", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    await handleAgentError(ctx, "ch1", "ag1", err)
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("network")
    expect(c.userMessage).not.toContain("ECONNRESET")
    expect(c.context.recoverable).toBe(true)
  })

  it("ETIMEDOUT → timeout message", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" })
    await handleAgentError(ctx, "ch1", "ag1", err)
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("network")
    expect(c.context.recoverable).toBe(true)
  })

  it("token expired → auth expired, non-recoverable", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("OAuth token expired"))
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("session")
    expect(c.context.recoverable).toBe(false)
  })

  it("ENOENT → file not found", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("ENOENT: no such file '/tmp/x'"))
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("validation")
    expect(c.context.recoverable).toBe(false)
  })

  it("unknown error → safe fallback, no raw message leak", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("xJ8#internal-crash-dump"))
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("unknown")
    expect(c.userMessage).not.toContain("xJ8#internal-crash-dump")
    expect(c.technicalMessage).toContain("xJ8#internal-crash-dump")
    expect(c.context.recoverable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AgentError instances — preserved
// ---------------------------------------------------------------------------

describe("handleAgentError — AgentError preservation", () => {
  it("LLMError preserves type and userMessage", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = new LLMError("Custom LLM message", "technical details", { source: "Claude" })
    await handleAgentError(ctx, "ch1", "ag1", err)
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("llm")
    expect(c.userMessage).toBe("Custom LLM message")
    expect(c.technicalMessage).toBe("technical details")
    expect(c.context.source).toBe("Claude")
    expect(c.context).toHaveProperty("recoverable")
  })

  it("ToolError preserves type", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = new ToolError("Tool broke", "tool details")
    await handleAgentError(ctx, "ch1", "ag1", err)
    expect(contentOf(broadcast).errorType).toBe("tool")
  })

  it("SessionError preserves type", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = new SessionError("Session lost", "session details")
    await handleAgentError(ctx, "ch1", "ag1", err)
    expect(contentOf(broadcast).errorType).toBe("session")
  })

  it("NetworkError preserves type", async () => {
    const { ctx, broadcast } = makeCtx()
    const err = new NetworkError("Network down", "network details")
    await handleAgentError(ctx, "ch1", "ag1", err)
    expect(contentOf(broadcast).errorType).toBe("network")
  })
})

// ---------------------------------------------------------------------------
// Message structure
// ---------------------------------------------------------------------------

describe("handleAgentError — message structure", () => {
  it("saves message and broadcasts", async () => {
    const { ctx, saved, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("test"))
    expect(saved).toHaveLength(1)
    expect(broadcast).toHaveLength(1)
    expect(saved[0].channelId).toBe("ch1")
    expect(saved[0].agentId).toBe("ag1")
    expect(saved[0].role).toBe("assistant")
    expect(saved[0].content.type).toBe("error")
  })

  it("context always has i18nKey", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(ctx, "ch1", "ag1", new Error("any error"))
    expect(contentOf(broadcast).context.i18nKey).toBeTypeOf("string")
    expect(contentOf(broadcast).context.i18nKey.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Classified provider errors (TER-697/TER-699) — the end-to-end backend seam:
// the REAL adapter classifies a Fireworks/Together failure, and handleAgentError
// serialises it into the exact WS `error` message the frontend ProviderErrorWidget
// consumes. Proves errorClass + errorSubReason + the literal upstreamMessage all
// cross the wire (they ride on the open `context` record, no schema change).
// ---------------------------------------------------------------------------

const providerAdapter = new OpenAICompatibleLLMAdapter({
  baseUrl: "https://api.fireworks.ai/inference/v1",
  model: "accounts/fireworks/models/glm-5p2",
  apiKey: "test-key",
  actualProvider: "fireworks",
})

/** Build the classified LLMError the adapter would throw for a real provider HTTP error. */
function classifiedError(
  status: number,
  body: { message?: string; type?: string },
  headers?: Record<string, string>,
): LLMError {
  const apiErr = OpenAI.APIError.generate(
    status,
    { error: body },
    body.message,
    new Headers(headers ?? {}),
  )
  return (providerAdapter as any).createLLMError(apiErr, {}) as LLMError
}

describe("handleAgentError — classified provider errors (TER-697)", () => {
  it("429 → the error event carries rate_limited / provider_capacity + literal upstream + retry context", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(
      ctx,
      "ch1",
      "ag1",
      classifiedError(
        429,
        { message: "rate limit exceeded, please try again later" },
        {
          "retry-after": "30",
        },
      ),
    )
    const c = contentOf(broadcast)
    expect(c.errorType).toBe("llm")
    expect(c.context.errorClass).toBe("rate_limited")
    expect(c.context.errorSubReason).toBe("provider_capacity")
    // The literal provider text survives verbatim (TER-222) for the ops feed /
    // technical disclosure — but NOT in the warm userMessage the user reads.
    expect(c.context.upstreamMessage).toContain("rate limit exceeded")
    expect(c.userMessage).not.toContain("rate limit exceeded")
    // Transient → the countdown context the widget renders is present.
    expect(c.context.isRateLimit).toBe(true)
    expect(typeof c.context.retryAfterSecs).toBe("number")
    // handleAgentError still stamps recoverable + i18nKey.
    expect(c.context).toHaveProperty("recoverable")
    expect(c.context.i18nKey).toBeTypeOf("string")
  })

  it("402 → spend_gate / provider_billing, persistent (no rate-limit context)", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(
      ctx,
      "ch1",
      "ag1",
      classifiedError(402, { message: "account not on paid plan or exceeded usage limits" }),
    )
    const c = contentOf(broadcast)
    expect(c.context.errorClass).toBe("spend_gate")
    expect(c.context.errorSubReason).toBe("provider_billing")
    expect(c.context.isRateLimit).toBeUndefined()
    expect(c.context.upstreamMessage).toContain("not on paid plan")
  })

  it("404 → not_found / model_unavailable, persistent", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(
      ctx,
      "ch1",
      "ag1",
      classifiedError(404, { message: "model accounts/fireworks/models/glm-5p2 not found" }),
    )
    const c = contentOf(broadcast)
    expect(c.context.errorClass).toBe("not_found")
    expect(c.context.errorSubReason).toBe("model_unavailable")
  })

  it("503 → overloaded / provider_overloaded, transient", async () => {
    const { ctx, broadcast } = makeCtx()
    await handleAgentError(
      ctx,
      "ch1",
      "ag1",
      classifiedError(503, { message: "the model is currently overloaded" }),
    )
    const c = contentOf(broadcast)
    expect(c.context.errorClass).toBe("overloaded")
    expect(c.context.errorSubReason).toBe("provider_overloaded")
  })
})
