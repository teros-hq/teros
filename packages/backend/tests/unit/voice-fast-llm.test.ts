/**
 * Voice Mode v2 — F5a tests: the fast LLM leg for voice turns.
 *
 * Coverage, by acceptance criterion:
 *
 *  1. Plan selector (`resolveVoiceLlmPlan`):
 *     - flag 'agent' (default) → agent plan, no degrade reason — ZERO change.
 *     - flag 'fast' + teros provider + active catalogue model → fast plan
 *       with model/modelString/effort/trimmed prompt/history limit.
 *     - flag 'fast' but non-teros provider → degrades to agent with a reason.
 *     - flag 'fast' but unknown modelId → degrades to agent with a reason.
 *     - flag 'fast' but deprecated model → degrades to agent with a reason.
 *     - effort normalization: unknown → 'none'; 'low' passes through.
 *
 *  2. Voice system prompt (`buildVoiceSystemPrompt`):
 *     - identity (name/fullName/role) + voice instructions (short, natural,
 *       no markdown) — and NOT the agent's full prompt.
 *
 *  3. Fallback wrapper (`VoiceFastFallbackClient`):
 *     - fast model succeeds → fast response passes through, agent untouched.
 *     - fast model fails BEFORE output (transient) → retried ONCE on the
 *       agent model, with the agent's FULL system prompt re-injected and the
 *       finish tagged (voiceFastFallbackUsed + reason).
 *     - fast model fails AFTER output → error surfaces (no duplicate turn).
 *     - non-transient error → surfaces (no pointless retry).
 *
 *  4. Latency budget leg split (`VoiceLoopLatencyBudget.statsByLlmLeg`):
 *     - fast-leg and agent-leg turns record into separate histograms while
 *       the aggregate 'llm' segment keeps every sample (backward compatible).
 */

import { describe, expect, it } from "bun:test";
import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core";
import {
  buildVoiceSystemPrompt,
  isVoiceFastFallbackWorthy,
  normalizeFastEffort,
  resolveVoiceLlmPlan,
  VoiceFastFallbackClient,
  VOICE_FAST_HISTORY_LIMIT,
  VOICE_FAST_MAX_TOOLS,
} from "../../src/services/voice-fast-llm";
import { TurnLatencyTrace, VoiceLoopLatencyBudget } from "../../src/services/voice-loop-latency";

const AGENT = { name: "Alice", fullName: "Alice Teros", role: "COO", intro: "La operadora." };

const AGENT_FLAGS = { llm: "agent", fastModel: "teros-s", fastEffort: "none" };
// TPROV-REQ-8: the fast leg is a Teros SIZE; the size router maps it to the configured upstream model.
const FAST_FLAGS = { llm: "fast", fastModel: "teros-s", fastEffort: "none" };

describe("F5a — resolveVoiceLlmPlan (plan selector)", () => {
  it("flag 'agent' (default) keeps the agent model — zero change, no degrade reason", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(AGENT_FLAGS, AGENT, "teros");
    expect(plan).toEqual({ mode: "agent" });
    expect(degradeReason).toBeUndefined();
  });

  it("flag 'fast' + teros provider + active catalogue model → the fast plan", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros");
    expect(degradeReason).toBeUndefined();
    if (plan.mode !== "fast") throw new Error("expected fast plan");
    expect(plan.modelId).toBe("teros-s");
    expect(plan.modelString).toBe("teros-s");
    expect(plan.reasoningEffort).toBe("none");
    expect(plan.historyLimit).toBe(VOICE_FAST_HISTORY_LIMIT);
    // The trimmed prompt is the VOICE prompt, not the agent's full prompt.
    expect(plan.systemPrompt).toContain("Alice Teros");
    expect(plan.systemPrompt).toContain("POR VOZ");
    expect(plan.systemPrompt).not.toContain("## Your Identity");
  });

  it("flag 'fast' but a non-teros turn (BYOK) → degrades to the agent model with a reason", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "anthropic");
    expect(plan).toEqual({ mode: "agent" });
    expect(degradeReason).toContain("not teros");
  });

  it("flag 'fast' but an unknown modelId → degrades to the agent model with a reason", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(
      { ...FAST_FLAGS, fastModel: "teros-nonexistent-flash" },
      AGENT,
      "teros",
    );
    expect(plan).toEqual({ mode: "agent" });
    expect(degradeReason).toContain("not in the Teros catalogue");
  });

  it("flag 'fast' but a deprecated model → degrades to the agent model with a reason", () => {
    // Find a deprecated catalogue model to point the flag at.
    const { MODELS_TEROS } = require("../../src/models/providers/teros");
    const deprecated = MODELS_TEROS.find((m: any) => m.status === "deprecated");
    if (!deprecated) return; // catalogue has no deprecated models — nothing to pin
    const { plan, degradeReason } = resolveVoiceLlmPlan(
      { ...FAST_FLAGS, fastModel: deprecated.modelId },
      AGENT,
      "teros",
    );
    expect(plan).toEqual({ mode: "agent" });
    expect(degradeReason).toContain("deprecated");
  });

  it("the other sizes resolve too (M with 'low', L with 'none') [TPROV-REQ-8]", () => {
    const m = resolveVoiceLlmPlan({ llm: "fast", fastModel: "teros-m", fastEffort: "low" }, AGENT, "teros");
    if (m.plan.mode !== "fast") throw new Error("expected M fast plan");
    expect(m.plan.modelString).toBe("teros-m");
    expect(m.plan.reasoningEffort).toBe("low");
    const l = resolveVoiceLlmPlan({ llm: "fast", fastModel: "teros-l", fastEffort: "none" }, AGENT, "teros");
    if (l.plan.mode !== "fast") throw new Error("expected L fast plan");
    expect(l.plan.modelString).toBe("teros-l");
    expect(l.plan.reasoningEffort).toBe("none");
  });
});

describe("F5a — normalizeFastEffort", () => {
  it("passes the valid values through and defaults everything else to 'none'", () => {
    expect(normalizeFastEffort("low")).toBe("low");
    expect(normalizeFastEffort("medium")).toBe("medium");
    expect(normalizeFastEffort("high")).toBe("high");
    expect(normalizeFastEffort("none")).toBe("none");
    expect(normalizeFastEffort("banana")).toBe("none");
    expect(normalizeFastEffort(undefined)).toBe("none");
  });
});

describe("F5a — buildVoiceSystemPrompt", () => {
  it("carries identity + voice instructions and stays short", () => {
    const prompt = buildVoiceSystemPrompt(AGENT);
    expect(prompt).toContain("Alice Teros");
    expect(prompt).toContain("COO");
    expect(prompt).toContain("POR VOZ");
    expect(prompt).toContain("Nada de markdown");
    // Short by construction: a handful of lines, never the full agent prompt.
    expect(prompt.length).toBeLessThan(1200);
  });

  it("falls back to the plain name when no fullName", () => {
    const prompt = buildVoiceSystemPrompt({ name: "Nira" });
    expect(prompt).toContain("Eres Nira");
  });
});

// ── ILLMClient test doubles ─────────────────────────────────────────────────

function fakeClient(
  behavior: (options: StreamMessageOptions) => Promise<LLMResponse>,
): ILLMClient & { calls: StreamMessageOptions[] } {
  const calls: StreamMessageOptions[] = [];
  const client: ILLMClient = {
    async streamMessage(options) {
      calls.push(options);
      const res = await behavior(options);
      // A real instrumented client fires onFinish on success (ILLMClient.ts:100).
      await options.callbacks?.onFinish?.({});
      return res;
    },
    getProviderInfo() {
      return { name: "fake", model: "fake-model", capabilities: { streaming: true, tools: true, thinking: false, vision: false } };
    },
  };
  return Object.assign(client, { calls });
}

const OK_RESPONSE = { content: [{ type: "text", text: "done" }] } as unknown as LLMResponse;

describe("F5a — VoiceFastFallbackClient (fast → agent fallback)", () => {
  it("fast model succeeds → the fast response passes through, the agent client is never called", async () => {
    const fast = fakeClient(async () => OK_RESPONSE);
    const agent = fakeClient(async () => OK_RESPONSE);
    const wrapper = new VoiceFastFallbackClient(fast, agent, "AGENT FULL PROMPT");

    const seen: string[] = [];
    const res = await wrapper.streamMessage({
      messages: [],
      systemPrompt: "VOICE PROMPT",
      callbacks: {
        onText: async (chunk) => {
          seen.push(chunk);
        },
      },
    } as StreamMessageOptions);

    expect(res).toBe(OK_RESPONSE);
    expect(fast.calls.length).toBe(1);
    expect(agent.calls.length).toBe(0);
    // The fast leg keeps the trimmed voice prompt.
    expect(fast.calls[0].systemPrompt).toBe("VOICE PROMPT");
  });

  it("fast model fails before output (transient) → ONE retry on the agent model with the agent's FULL prompt, finish tagged", async () => {
    const fast = fakeClient(async () => {
      throw Object.assign(new Error("upstream timeout"), {
        context: { errorClass: "connection" },
      });
    });
    const agent = fakeClient(async () => OK_RESPONSE);
    const wrapper = new VoiceFastFallbackClient(fast, agent, "AGENT FULL PROMPT");

    const finishes: any[] = [];
    const res = await wrapper.streamMessage({
      messages: [],
      systemPrompt: "VOICE PROMPT",
      callbacks: {
        onFinish: async (info) => {
          finishes.push(info);
        },
      },
    } as StreamMessageOptions);

    expect(res).toBe(OK_RESPONSE);
    expect(fast.calls.length).toBe(1);
    expect(agent.calls.length).toBe(1);
    // The agent leg gets its OWN full system prompt back — the trimmed voice
    // prompt was only for the fast leg.
    expect(agent.calls[0].systemPrompt).toBe("AGENT FULL PROMPT");
    // The finish is tagged so telemetry counts the fallback with its reason.
    expect(finishes.length).toBe(1);
    expect(finishes[0].voiceFastFallbackUsed).toBe(true);
    expect(String(finishes[0].voiceFastFallbackReason)).toContain("connection");
  });

  it("fast model fails AFTER streaming output → the error surfaces (never duplicate the spoken turn)", async () => {
    const fast = fakeClient(async (options) => {
      await options.callbacks?.onText?.("partial answer");
      throw new Error("mid-stream failure");
    });
    const agent = fakeClient(async () => OK_RESPONSE);
    const wrapper = new VoiceFastFallbackClient(fast, agent, "AGENT FULL PROMPT");

    let surfaced: unknown = null;
    try {
      await wrapper.streamMessage({ messages: [] } as StreamMessageOptions);
    } catch (err) {
      surfaced = err;
    }
    expect(surfaced).toBeInstanceOf(Error);
    // No fallback after user-visible output.
    expect(agent.calls.length).toBe(0);
  });

  it("non-transient fast error (e.g. auth) → surfaces without a pointless retry", async () => {
    const fast = fakeClient(async () => {
      throw Object.assign(new Error("401 unauthorized"), {
        context: { errorClass: "auth" },
      });
    });
    const agent = fakeClient(async () => OK_RESPONSE);
    const wrapper = new VoiceFastFallbackClient(fast, agent, "AGENT FULL PROMPT");

    let surfaced: unknown = null;
    try {
      await wrapper.streamMessage({ messages: [] } as StreamMessageOptions);
    } catch (err) {
      surfaced = err;
    }
    expect(errorWasSurfaced(surfaced)).toBe(true);
    expect(agent.calls.length).toBe(0);
  });
});

function errorWasSurfaced(v: unknown): boolean {
  return v instanceof Error;
}

describe("F5a — isVoiceFastFallbackWorthy", () => {
  it("transient classes and timeout-ish messages are worthy; auth is not", () => {
    expect(isVoiceFastFallbackWorthy({ context: { errorClass: "rate_limited" } })).toBe(true);
    expect(isVoiceFastFallbackWorthy({ context: { errorClass: "server_error" } })).toBe(true);
    expect(isVoiceFastFallbackWorthy(new Error("Request timed out"))).toBe(true);
    expect(isVoiceFastFallbackWorthy({ context: { errorClass: "auth" } })).toBe(false);
    expect(isVoiceFastFallbackWorthy(new Error("spend gate"))).toBe(false);
  });
});

describe("F5a — VoiceLoopLatencyBudget leg split (telemetry fast vs agent)", () => {
  it("splits the LLM segment by leg while the aggregate keeps every sample", () => {
    const budget = new VoiceLoopLatencyBudget();
    const clock = { t: 0 };
    const mk = () => {
      clock.t += 1000;
      return () => clock.t;
    };

    // A fast-leg turn: sttFinal at t, first text chunk +300ms.
    const fastTrace = new TurnLatencyTrace(mk());
    fastTrace.markSttFinal();
    clock.t += 300;
    fastTrace.markFirstTextChunk();
    fastTrace.llmLeg = "fast";
    budget.record(fastTrace);

    // An agent-leg turn: sttFinal at t, first text chunk +900ms.
    const agentTrace = new TurnLatencyTrace(mk());
    agentTrace.markSttFinal();
    clock.t += 900;
    agentTrace.markFirstTextChunk();
    agentTrace.llmLeg = "agent";
    budget.record(agentTrace);

    const byLeg = budget.statsByLlmLeg();
    expect(byLeg.fast.count).toBe(1);
    expect(byLeg.agent.count).toBe(1);
    // The histogram is bucketed with Prometheus-style interpolation (TER-616):
    // a single 300ms sample lands in the [160, 320] bucket, so p50 interpolates
    // to the bucket midpoint (240) — NOT the raw sample. The MEAN is exact.
    expect(byLeg.fast.mean).toBe(300);
    expect(byLeg.agent.mean).toBe(900);
    expect(byLeg.fast.p50).toBeGreaterThanOrEqual(160);
    expect(byLeg.fast.p50).toBeLessThanOrEqual(320);
    expect(byLeg.agent.p50).toBeGreaterThanOrEqual(640);
    expect(byLeg.agent.p50).toBeLessThanOrEqual(1280);

    // The aggregate 'llm' segment keeps BOTH samples (backward compatible).
    const aggregate = budget.stats("llm");
    expect(aggregate.count).toBe(2);
  });

  it("default leg is 'agent' — a trace that never stamps the leg lands in the agent histogram", () => {
    const budget = new VoiceLoopLatencyBudget();
    const trace = new TurnLatencyTrace();
    trace.markSttFinal();
    trace.markFirstTextChunk();
    budget.record(trace); // no llmLeg assignment
    const byLeg = budget.statsByLlmLeg();
    expect(byLeg.agent.count).toBe(1);
    expect(byLeg.fast.count).toBe(0);
  });
});

// ============================================================================
// F5j (2026-10-05) — tool calls execute in voice mode
//
// Live incident: the agent answered "sí, lo apunto" in text without ever
// emitting the tool call, and every attempt died on Fireworks "Grammar
// processing took too much time" (1062 tools). Three seams are covered:
//  1. `isVoiceFastFallbackWorthy` — the grammar 400 is fallback-worthy.
//  2. `VoiceFastFallbackClient` — a grammar failure BEFORE output retries the
//     turn on the agent model (tools ride the turn — same list as chat).
//  3. `resolveVoiceLlmPlan` — a tool list above VOICE_FAST_MAX_TOOLS skips the
//     fast leg up front (no doomed request, no error-time fallback needed).
//  4. `buildVoiceSystemPrompt` — the trimmed prompt tells the model to EXECUTE
//     actions with its tools, never to promise without executing.
// ============================================================================

describe("F5j — grammar-compilation failure is fallback-worthy", () => {
  it("the live Fireworks grammar error (1062 tools) is fallback-worthy", () => {
    // Verbatim from the 2026-10-05 incident (channel_messages content.error).
    const grammarError = Object.assign(
      new Error(
        "Fireworks error: Grammar processing took too much time. Likely the grammar allows too much branching. Please simplify the grammar or reach out to Fireworks for support.",
      ),
      { context: { model: "accounts/fireworks/routers/kimi-k3-fast", toolCount: 1062 } },
    );
    expect(isVoiceFastFallbackWorthy(grammarError)).toBe(true);
  });

  it("an unclassified 400 whose text is NOT a grammar failure stays non-worthy (no pointless retries)", () => {
    expect(isVoiceFastFallbackWorthy(new Error("invalid request body"))).toBe(false);
  });

  it("a message that mentions grammar but is not a compilation timeout is not matched alone", () => {
    // "grammar" alone (e.g. a user discussing grammar) must not trigger the
    // fallback — the branch requires the compilation-timeout signal too.
    expect(isVoiceFastFallbackWorthy(new Error("grammar discussion"))).toBe(false);
  });
});

describe("F5j — VoiceFastFallbackClient retries a grammar failure on the agent model", () => {
  it("fast model 400s on grammar (before output) → the turn retries on the agent model with its full prompt, finish tagged", async () => {
    const fast = fakeClient(async () => {
      // The live incident error, thrown before any token was streamed.
      throw Object.assign(
        new Error(
          "Fireworks error: Grammar processing took too much time. Likely the grammar allows too much branching.",
        ),
        { context: { model: "accounts/fireworks/routers/kimi-k3-fast", toolCount: 1062 } },
      );
    });
    const agent = fakeClient(async () => OK_RESPONSE);
    const wrapper = new VoiceFastFallbackClient(fast, agent, "AGENT FULL PROMPT");

    const finishes: any[] = [];
    const res = await wrapper.streamMessage({
      messages: [],
      systemPrompt: "VOICE PROMPT",
      tools: [{ name: "todo-list_add-node", description: "add a node", input_schema: {} }],
      callbacks: {
        onFinish: async (info) => {
          finishes.push(info);
        },
      },
    } as StreamMessageOptions);

    expect(res).toBe(OK_RESPONSE);
    expect(fast.calls.length).toBe(1);
    expect(agent.calls.length).toBe(1);
    // The agent leg gets its OWN full system prompt back (tools ride the turn).
    expect(agent.calls[0].systemPrompt).toBe("AGENT FULL PROMPT");
    expect(finishes.length).toBe(1);
    expect(finishes[0].voiceFastFallbackUsed).toBe(true);
    expect(String(finishes[0].voiceFastFallbackReason)).toContain("Grammar");
  });
});

describe("F5j — resolveVoiceLlmPlan skips the fast leg above the grammar-safe tool ceiling", () => {
  it("a tool list above VOICE_FAST_MAX_TOOLS (the 1062-tool incident) degrades to the agent model with a reason", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros", 1062);
    expect(plan).toEqual({ mode: "agent" });
    expect(degradeReason).toContain("grammar-safe ceiling");
    expect(degradeReason).toContain("1062");
  });

  it("a small tool list (below the ceiling) keeps the fast plan — pure conversational turns stay fast", () => {
    const { plan, degradeReason } = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros", 5);
    expect(degradeReason).toBeUndefined();
    expect(plan.mode).toBe("fast");
  });

  it("no tool count passed (legacy callers) keeps the fast plan — the ceiling only applies when the count is known", () => {
    const { plan } = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros");
    expect(plan.mode).toBe("fast");
  });

  it("the ceiling boundary is exact (toolCount === ceiling is fast, ceiling+1 is agent)", () => {
    const atCeiling = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros", VOICE_FAST_MAX_TOOLS);
    expect(atCeiling.plan.mode).toBe("fast");
    const above = resolveVoiceLlmPlan(FAST_FLAGS, AGENT, "teros", VOICE_FAST_MAX_TOOLS + 1);
    expect(above.plan.mode).toBe("agent");
  });
});

describe("F5j — buildVoiceSystemPrompt instructs the model to EXECUTE actions", () => {
  it("the trimmed prompt tells the model to execute actions with its tools and never promise without executing", () => {
    const prompt = buildVoiceSystemPrompt(AGENT);
    expect(prompt).toContain("EJECÚTALO");
    expect(prompt).toContain("Nunca prometas una acción sin ejecutarla");
    // Still short — the latency goal of the trimmed prompt is preserved.
    expect(prompt.length).toBeLessThan(1400);
  });
});
