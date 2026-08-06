/**
 * Tests for TerosFallbackClient + helpers (TER-617 / F3).
 *
 * Pins the failover policy: cutover skips Fireworks; on-error retries on
 * Together ONLY for transient errors AND only when the primary produced no
 * output yet (no duplicated response); non-transient errors and post-output
 * errors surface.
 */

import { describe, expect, it } from "bun:test"
import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core"
import {
  isFailoverWorthy,
  normalizeFallbackMode,
  TerosFallbackClient,
} from "../../src/services/teros-fallback-client"

function errWithClass(errorClass: string, message = "boom"): Error {
  return Object.assign(new Error(message), { context: { errorClass } })
}

/** Fake adapter that optionally emits text then optionally throws; counts calls. */
function fakeClient(opts: { tag: string; emit?: string; fail?: Error }): ILLMClient & {
  calls: number
} {
  return {
    calls: 0,
    async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
      ;(this as { calls: number }).calls += 1
      if (opts.emit) await options.callbacks?.onText?.(opts.emit)
      if (opts.fail) throw opts.fail
      return { stopReason: "end_turn", metadata: { tag: opts.tag } }
    },
    getProviderInfo() {
      return {
        name: opts.tag,
        model: "m",
        capabilities: { streaming: true, tools: true, thinking: false, vision: true },
      }
    },
  }
}

function optionsCapturing(sink: string[]): StreamMessageOptions {
  return {
    messages: [],
    callbacks: {
      onText: (c) => {
        sink.push(c)
      },
    },
  } as unknown as StreamMessageOptions
}

describe("normalizeFallbackMode", () => {
  it("passes through known modes, coerces everything else to off", () => {
    expect(normalizeFallbackMode("off")).toBe("off")
    expect(normalizeFallbackMode("on-error")).toBe("on-error")
    expect(normalizeFallbackMode("cutover")).toBe("cutover")
    expect(normalizeFallbackMode("garbage")).toBe("off")
    expect(normalizeFallbackMode(undefined)).toBe("off")
    expect(normalizeFallbackMode(42)).toBe("off")
  })
})

describe("isFailoverWorthy", () => {
  it("is true for transient error classes", () => {
    for (const ec of ["rate_limited", "overloaded", "server_error", "connection"]) {
      expect(isFailoverWorthy(errWithClass(ec))).toBe(true)
    }
  })

  it("is false for non-transient error classes (same failure on Together)", () => {
    for (const ec of ["context_length", "auth", "spend_gate", "not_found"]) {
      expect(isFailoverWorthy(errWithClass(ec))).toBe(false)
    }
  })

  it("is true for timeouts that surface without an errorClass", () => {
    expect(isFailoverWorthy(new Error("Request timed out"))).toBe(true)
    expect(isFailoverWorthy(new Error("ETIMEDOUT"))).toBe(true)
  })

  it("is false for a plain error with no class and no timeout", () => {
    expect(isFailoverWorthy(new Error("weird"))).toBe(false)
  })
})

describe("TerosFallbackClient.streamMessage", () => {
  it("cutover → goes straight to the secondary (Together), skipping the primary", async () => {
    const primary = fakeClient({ tag: "fireworks" })
    const secondary = fakeClient({ tag: "together" })
    const wrap = new TerosFallbackClient(primary, secondary, "cutover")
    const res = await wrap.streamMessage(optionsCapturing([]))
    expect(res.metadata?.tag).toBe("together")
    expect(primary.calls).toBe(0)
    expect(secondary.calls).toBe(1)
  })

  it("on-error: primary OK → uses primary, never touches secondary", async () => {
    const primary = fakeClient({ tag: "fireworks" })
    const secondary = fakeClient({ tag: "together" })
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    const res = await wrap.streamMessage(optionsCapturing([]))
    expect(res.metadata?.tag).toBe("fireworks")
    expect(secondary.calls).toBe(0)
  })

  it("on-error: transient error BEFORE output → fails over to Together", async () => {
    const primary = fakeClient({ tag: "fireworks", fail: errWithClass("rate_limited") })
    const secondary = fakeClient({ tag: "together" })
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    const res = await wrap.streamMessage(optionsCapturing([]))
    expect(res.metadata?.tag).toBe("together")
    expect(primary.calls).toBe(1)
    expect(secondary.calls).toBe(1)
  })

  it("on-error: transient error AFTER output → surfaces (no duplicated response)", async () => {
    const sink: string[] = []
    const primary = fakeClient({
      tag: "fireworks",
      emit: "partial answer",
      fail: errWithClass("server_error"),
    })
    const secondary = fakeClient({ tag: "together" })
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    await expect(wrap.streamMessage(optionsCapturing(sink))).rejects.toThrow("boom")
    expect(secondary.calls).toBe(0) // must NOT retry after streaming content
    expect(sink).toEqual(["partial answer"]) // emitted exactly once
  })

  it("on-error: NON-transient error → surfaces, no failover", async () => {
    const primary = fakeClient({ tag: "fireworks", fail: errWithClass("context_length") })
    const secondary = fakeClient({ tag: "together" })
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    await expect(wrap.streamMessage(optionsCapturing([]))).rejects.toThrow()
    expect(secondary.calls).toBe(0)
  })

  it("no secondary (failover unavailable) → primary only, even on a transient error", async () => {
    const primary = fakeClient({ tag: "fireworks", fail: errWithClass("rate_limited") })
    const wrap = new TerosFallbackClient(primary, null, "on-error")
    await expect(wrap.streamMessage(optionsCapturing([]))).rejects.toThrow()
    expect(primary.calls).toBe(1)
  })

  it("cutover with no secondary → falls back to the primary", async () => {
    const primary = fakeClient({ tag: "fireworks" })
    const wrap = new TerosFallbackClient(primary, null, "cutover")
    const res = await wrap.streamMessage(optionsCapturing([]))
    expect(res.metadata?.tag).toBe("fireworks")
  })

  it("on-error failover: tags the secondary's onFinish with fallbackUsed + the primary error (R3.1)", async () => {
    const finishInfos: Array<Record<string, unknown>> = []
    const primary = fakeClient({ tag: "fireworks", fail: errWithClass("rate_limited") })
    // Secondary that emits onFinish — the pipeline reads fallbackUsed from here.
    const secondary: ILLMClient = {
      async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
        await options.callbacks?.onFinish?.({ stopReason: "end_turn" } as never)
        return { stopReason: "end_turn", metadata: { tag: "together" } }
      },
      getProviderInfo() {
        return {
          name: "together",
          model: "m",
          capabilities: { streaming: true, tools: true, thinking: false, vision: true },
        }
      },
    }
    const opts = {
      messages: [],
      callbacks: { onFinish: (info: Record<string, unknown>) => finishInfos.push(info) },
    } as unknown as StreamMessageOptions
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    await wrap.streamMessage(opts)
    expect(finishInfos).toHaveLength(1)
    // Mutation: passing `options` through (not enriching onFinish) → undefined → red.
    expect(finishInfos[0]!.fallbackUsed).toBe(true)
    expect(finishInfos[0]!.primaryProvider).toBe("fireworks")
    expect(finishInfos[0]!.primaryErrorClass).toBe("rate_limited")
  })

  it("on-error: thinking output before a transient error blocks failover (R8.4 guard)", async () => {
    // Kimi's thinking channel counts as produced output: failing over would
    // duplicate the visible turn. Mutation: drop the onThinking guard → failover → red.
    const secondary = fakeClient({ tag: "together" })
    const primary: ILLMClient = {
      async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
        await options.callbacks?.onThinking?.("reasoning…")
        throw errWithClass("rate_limited")
      },
      getProviderInfo() {
        return {
          name: "fireworks",
          model: "m",
          capabilities: { streaming: true, tools: true, thinking: true, vision: true },
        }
      },
    }
    const wrap = new TerosFallbackClient(primary, secondary, "on-error")
    await expect(wrap.streamMessage(optionsCapturing([]))).rejects.toThrow()
    expect(secondary.calls).toBe(0)
  })
})
