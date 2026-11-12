/**
 * Voice Fast LLM leg (Voice Mode v2 — F5a)
 *
 * Diagnosis (docs/specs/voice-mode/2026-10-realtime-latency-research.md §1):
 * the LLM segment is ~70% of the measured 5-6s voice-turn latency — voice
 * turns run the agent's LARGE model with the FULL channel context. Nobody in
 * the market does that; everyone runs a fast model with a trimmed context for
 * the spoken turn (§4 Fase A).
 *
 * This module is the pure, unit-testable core of the fix:
 *
 *   1. `resolveVoiceLlmPlan` — flag-gated plan selector: 'agent' (default,
 *      zero change) or 'fast' (a Teros-provider fast model from the catalogue
 *      + a trimmed voice system prompt + a history limit).
 *   2. `buildVoiceSystemPrompt` — the short spoken-turn system prompt
 *      (agent identity + voice instructions: brief, natural, no markdown).
 *   3. `VoiceFastFallbackClient` — ILLMClient wrapper (same pattern as
 *      TerosFallbackClient, TER-617/F3): primary = the fast model, secondary
 *      = the agent's own model. On a transient error BEFORE any output, the
 *      turn falls back to the agent model — re-injecting the agent's FULL
 *      system prompt, because the trimmed voice prompt only makes sense for
 *      the fast leg. Fallbacks are tagged on onFinish (voiceFastFallbackUsed
 *      + reason) so telemetry can tell them apart.
 *
 * Everything here is pure logic / thin wrappers — no I/O, no flags service,
 * no secrets. The wiring lives in message-handler.ts (flag resolution per
 * user) and voice-loop.ts (marking the turn as voice-originated).
 */

import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core";
import { MODELS_TEROS } from "../models/providers/teros";
import type { ModelDefinition } from "../models/types";

// ============================================================================
// PLAN SELECTOR
// ============================================================================

/** History lines the fast voice leg keeps (last N messages of the thread). */
export const VOICE_FAST_HISTORY_LIMIT = 12;

/**
 * Grammar-safe tool ceiling for the fast leg (F5j, 2026-10-05).
 *
 * Fireworks compiles the request's tool schemas to a GBNF grammar
 * server-side before serving a fast/router model. Above a few hundred
 * tools the compilation exceeds its time limit and the whole request 400s
 * ("Grammar processing took too much time. Likely the grammar allows too
 * much branching") — the live incident had 1062 tools. Rather than pay the
 * failed-request latency and rely on the error-time fallback, a turn whose
 * tool list exceeds this ceiling skips the fast leg up front and runs on
 * the agent model (native tool calling, no grammar pass). The threshold is
 * conservative: the incident threshold is unknown, but 1062 failed on
 * BOTH fast candidates (deepseek-v4p1-flash and kimi-k3-fast routers) while
 * small sets (5 tools) compile fine.
 */
export const VOICE_FAST_MAX_TOOLS = 128;

export interface VoiceLlmFlagValues {
  /** `voice.llm` — 'agent' (default) | 'fast'. */
  llm: string;
  /** `voice.llm-fast-model` — Teros modelId for the fast leg. */
  fastModel: string;
  /** `voice.llm-fast-effort` — reasoning_effort ('none' | 'low' | 'medium' | 'high'). */
  fastEffort: string;
}

/** Minimal agent shape the voice prompt needs (from getEffectiveAgentConfig). */
export interface VoiceAgentIdentity {
  name: string;
  fullName?: string;
  role?: string;
  intro?: string;
}

export type VoiceLlmPlan =
  | { mode: "agent" }
  | {
      mode: "fast";
      /** Teros modelId from the catalogue (e.g. 'teros-deepseek-v4p1-flash'). */
      modelId: string;
      /** Upstream model string (e.g. 'accounts/fireworks/models/deepseek-v4p1-flash'). */
      modelString: string;
      /** reasoning_effort to send upstream ('none' for deepseek/kimi, 'low' for glm flash). */
      reasoningEffort: string;
      /** Trimmed system prompt for the spoken turn. */
      systemPrompt: string;
      /** History lines the turn keeps (the agent leg keeps everything). */
      historyLimit: number;
    };

/**
 * Resolve the LLM plan for a voice-originated turn. Pure.
 *
 * - flag 'agent' (or anything unknown) → `{ mode: 'agent' }` — the caller
 *   keeps the current behavior untouched (zero change with the flag off).
 * - flag 'fast' + a known ACTIVE Teros fast model + a `teros` provider turn
 *   → the fast plan (model + trimmed prompt + history limit).
 * - flag 'fast' but the model is unknown/disabled, or the turn's provider is
 *   not `teros` → degrades to `{ mode: 'agent' }` with a reason the caller
 *   logs (never break the voice turn because of a bad flag value).
 */
export function resolveVoiceLlmPlan(
  flags: VoiceLlmFlagValues,
  agent: VoiceAgentIdentity,
  providerType: string | undefined,
  /** F5j: the turn's tool count — a tool list above VOICE_FAST_MAX_TOOLS skips the fast leg up front. */
  toolCount?: number,
): { plan: VoiceLlmPlan; degradeReason?: string } {
  if (flags.llm !== "fast") {
    return { plan: { mode: "agent" } };
  }
  // F5j (2026-10-05): too many tools for the Fireworks grammar pass — run
  // the turn on the agent model directly (native tool calling) instead of
  // paying a doomed request + error-time fallback. Latency trade-off: the
  // agent leg is slower (~10s vs ~2s), but the fast leg CANNOT serve this
  // turn at all (grammar 400) — the only fast alternative would be stripping
  // tools, which is exactly the bug (promising actions without executing).
  if (typeof toolCount === "number" && toolCount > VOICE_FAST_MAX_TOOLS) {
    return {
      plan: { mode: "agent" },
      degradeReason: `voice fast leg skipped — ${toolCount} tools exceed the grammar-safe ceiling (${VOICE_FAST_MAX_TOOLS}); Fireworks grammar compilation would fail — keeping the agent model`,
    };
  }
  // The fast leg only exists on the Teros provider (catalogue models + system
  // secrets). A BYOK voice turn keeps its own provider/model.
  if (providerType !== "teros") {
    return {
      plan: { mode: "agent" },
      degradeReason: `voice.llm=fast but the turn's provider is '${providerType}' (not teros) — keeping the agent model`,
    };
  }
  const model = findTerosModel(flags.fastModel);
  if (!model) {
    return {
      plan: { mode: "agent" },
      degradeReason: `voice.llm-fast-model='${flags.fastModel}' is not in the Teros catalogue — keeping the agent model`,
    };
  }
  if (model.status !== "active") {
    return {
      plan: { mode: "agent" },
      degradeReason: `voice.llm-fast-model='${flags.fastModel}' is ${model.status} (not active) — keeping the agent model`,
    };
  }
  return {
    plan: {
      mode: "fast",
      modelId: model.modelId,
      modelString: model.modelString,
      reasoningEffort: normalizeFastEffort(flags.fastEffort),
      systemPrompt: buildVoiceSystemPrompt(agent),
      historyLimit: VOICE_FAST_HISTORY_LIMIT,
    },
  };
}

/** Find a Teros catalogue model by modelId (case-insensitive on the id). */
export function findTerosModel(modelId: string): ModelDefinition | undefined {
  return MODELS_TEROS.find((m) => m.modelId === modelId);
}

/** Coerce the effort flag into a value the upstream accepts; default 'none'. */
export function normalizeFastEffort(raw: string | undefined): string {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : "none";
}

// ============================================================================
// VOICE SYSTEM PROMPT
// ============================================================================

/**
 * The short system prompt for a spoken turn. What the whole market sends the
 * fast model: identity + "you are being spoken to, answer like speech".
 *
 * Deliberately NOT the agent's full prompt (core prompt + skills + workspace
 * context + project context + <context> block) — that is the latency killer
 * this leg removes. The agent's tools are still injected by the normal
 * pipeline (the tool list rides the turn, not the system prompt).
 */
export function buildVoiceSystemPrompt(agent: VoiceAgentIdentity): string {
  const lines: string[] = [];
  lines.push(
    `Eres ${agent.fullName || agent.name}${agent.role ? `, ${agent.role}` : ""}, en una conversación POR VOZ con el usuario.`,
  );
  if (agent.intro) {
    lines.push(agent.intro);
  }
  lines.push(
    "Cómo responder:",
    "- Hablas: la respuesta se convierte en audio. Frases cortas y naturales, como una persona hablando.",
    "- Nada de markdown (ni listas, ni **negritas**, ni código salvo que te lo pidan explícitamente).",
    "- Ve al grano: primero la respuesta, luego el detalle solo si hace falta.",
    "- Si necesitas una herramienta, úsala; pero mantén la respuesta hablada breve.",
    "- Si no entiendes o no te dirigieron nada relevante, responde lo mínimo o nada sustancial.",
    // F5j (2026-10-05): the live incident — the agent PROMISED actions in
    // text ("sí, lo apunto") without ever emitting the tool call. The trimmed
    // prompt carried no tool-use instruction, so the fast model answered
    // conversationally even for clear action requests. Tools ride the turn
    // (same tool list as chat); this line tells the model to USE them and
    // report the real result, never to promise without executing.
    "- Si te piden hacer algo (apuntar, crear, buscar, cambiar), EJECÚTALO con tus herramientas y responde con el resultado real. Nunca prometas una acción sin ejecutarla: si puedes hacerla, hazla; si no puedes, dilo.",
  );
  return lines.join("\n");
}

// ============================================================================
// FALLBACK WRAPPER (fast → agent)
// ============================================================================

/**
 * Error classes that justify falling back from the fast model to the agent
 * model (same set as TerosFallbackClient — transient upstream failures).
 */
const FALLBACK_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "connection",
  "context_length",
  "not_found",
]);

/**
 * True when a fast-model error warrants the fallback to the agent model.
 *
 * F5j (2026-10-05): grammar-compilation failures are now fallback-worthy.
 * Fireworks compiles the tool schemas to a GBNF grammar server-side and a
 * many-MCA agent (1062 tools in the live incident) exceeds the compilation
 * time limit — "Grammar processing took too much time. Likely the grammar
 * allows too much branching." The error arrives as an unclassified 400 (no
 * `errorClass`), so it fell through every branch here and the turn DIED with
 * a visible endpoint error instead of falling back to the agent model (which
 * serves tool calling natively, no grammar). Match the literal upstream text —
 * "grammar" + "branching"/"took too much time" — so the turn retries on the
 * agent leg and the spoken answer reflects the real tool result.
 */
export function isVoiceFastFallbackWorthy(err: unknown): boolean {
  const errorClass = (err as { context?: { errorClass?: unknown } })?.context?.errorClass;
  if (typeof errorClass === "string" && FALLBACK_ERROR_CLASSES.has(errorClass)) return true;
  const msg = String((err as { message?: unknown })?.message ?? "").toLowerCase();
  // F5j: Fireworks grammar-compilation failure (too many tools) — fall back
  // to the agent model, which calls tools natively without a grammar pass.
  if (msg.includes("grammar") && (msg.includes("took too much time") || msg.includes("branching"))) {
    return true;
  }
  return (
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("timed out") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("404") ||
    msg.includes("400")
  );
}

/**
 * VoiceFastFallbackClient — primary = the fast model, secondary = the
 * agent's own model (same wrapper pattern as TerosFallbackClient, TER-617/F3).
 *
 * On a transient error BEFORE any user-visible output, the turn retries ONCE
 * on the agent model. The retry re-injects the agent's FULL system prompt
 * (the trimmed voice prompt only makes sense for the fast leg — the agent
 * model gets its own prompt back) and the full history is re-sent by the
 * caller via `historyLimit` (the fast leg sliced it; the agent leg must not).
 *
 * Fallbacks are tagged on `onFinish` (voiceFastFallbackUsed + reason) so
 * usage/telemetry can tell a fast turn from a fallen-back turn.
 */
export class VoiceFastFallbackClient implements ILLMClient {
  constructor(
    private readonly fast: ILLMClient,
    private readonly agent: ILLMClient,
    /** The agent's full system prompt, re-injected on the fallback call. */
    private readonly agentSystemPrompt: string,
  ) {}

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    // Track whether the fast leg streamed anything — never fall back after
    // user-visible output (would duplicate the spoken response).
    let emitted = false;
    const markEmitted = () => {
      emitted = true;
    };
    const guarded: StreamMessageOptions = {
      ...options,
      callbacks: {
        ...options.callbacks,
        onText: async (chunk) => {
          markEmitted();
          await options.callbacks?.onText?.(chunk);
        },
        onToolCall: async (toolCall) => {
          markEmitted();
          await options.callbacks?.onToolCall?.(toolCall);
        },
        onThinking: async (chunk) => {
          markEmitted();
          await options.callbacks?.onThinking?.(chunk);
        },
        onTextEnd: async () => {
          markEmitted();
          await options.callbacks?.onTextEnd?.();
        },
      },
    };

    try {
      return await this.fast.streamMessage(guarded);
    } catch (err) {
      if (!emitted && isVoiceFastFallbackWorthy(err)) {
        const errorClass = (err as { context?: { errorClass?: unknown } })?.context?.errorClass;
        const reason = String(errorClass ?? (err instanceof Error ? err.message : "error"));
        console.warn(
          `[VoiceFastLLM] fast model failed before output (${reason}) — falling back to the agent model`,
        );
        // The agent leg gets its own full system prompt back (the trimmed
        // prompt was only for the fast leg) and tags the finish so telemetry
        // counts the fallback.
        const fallbackOptions: StreamMessageOptions = {
          ...options,
          systemPrompt: this.agentSystemPrompt,
          callbacks: {
            ...options.callbacks,
            onFinish: (async (info: any) => {
              await options.callbacks?.onFinish?.({
                ...info,
                voiceFastFallbackUsed: true,
                voiceFastFallbackReason: reason,
              })
            }) as NonNullable<StreamMessageOptions["callbacks"]>["onFinish"],
          },
        };
        return await this.agent.streamMessage(fallbackOptions);
      }
      throw err;
    }
  }

  getProviderInfo() {
    return this.fast.getProviderInfo();
  }
}
