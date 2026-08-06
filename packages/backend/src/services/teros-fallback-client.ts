/**
 * TerosFallbackClient — flag-gated Fireworks→Together failover for the `teros`
 * provider (TER-617 / F3).
 *
 * Wraps two `ILLMClient` adapters (primary = Fireworks, secondary = Together)
 * and applies the `teros.fallback` policy per turn:
 *   - `off`       → handled upstream (this wrapper isn't built; primary used directly).
 *   - `cutover`   → go straight to the secondary (hard Fireworks outage).
 *   - `on-error`  → run the primary; on a TRANSIENT error retry ONCE on the
 *                   secondary. The primary POST is never retried in place (C6:
 *                   not idempotent → double billing) — the retry is a DIFFERENT
 *                   provider. Non-transient errors (context-window, 4xx, auth,
 *                   402 spend gate) surface with no retry (C5).
 *
 * Mid-stream safety: we only fail over when the primary produced NO output yet
 * (no text/tool chunk emitted). A transient error almost always fires on the
 * request (429/503 before the first chunk) → clean failover. If the primary
 * already streamed content, retrying on the secondary would duplicate the
 * user-visible response, so we surface the error instead.
 *
 * The manual gate (the flag) is the trigger, NOT a circuit-breaker. `actualProvider`
 * / fallback telemetry flows from each underlying adapter (F0/F1).
 */

import type { ILLMClient, LLMResponse, StreamMessageOptions } from "@teros/core"

export type TerosFallbackMode = "off" | "on-error" | "cutover"

/** Coerce a feature-flag string into a known mode (unknown → `off`). */
export function normalizeFallbackMode(raw: unknown): TerosFallbackMode {
  return raw === "on-error" || raw === "cutover" ? raw : "off"
}

/**
 * Error classes (from F0's `LLMError.context.errorClass`) that justify failing
 * over to the secondary upstream. Excludes non-transient classes that would
 * fail identically on Together (`context_length`, `auth`, `spend_gate`,
 * `not_found`) — those surface (C5).
 */
const FAILOVER_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "rate_limited",
  "overloaded",
  "server_error",
  "connection",
])

/** True when an error from the primary warrants a failover retry on the secondary. */
export function isFailoverWorthy(err: unknown): boolean {
  const errorClass = (err as { context?: { errorClass?: unknown } })?.context?.errorClass
  if (typeof errorClass === "string" && FAILOVER_ERROR_CLASSES.has(errorClass)) return true
  // Timeouts/stream-stalls may surface without an errorClass — duck-type the message.
  const msg = String((err as { message?: unknown })?.message ?? "").toLowerCase()
  return msg.includes("timeout") || msg.includes("etimedout") || msg.includes("timed out")
}

export class TerosFallbackClient implements ILLMClient {
  constructor(
    private readonly primary: ILLMClient,
    /** null when no failover target is available (no Together equivalent / missing secret / ZDR guard). */
    private readonly secondary: ILLMClient | null,
    private readonly mode: TerosFallbackMode,
  ) {
    // R8.4: a cutover with no target silently runs Fireworks. Surface it so a
    // misconfigured flag (armed but no ZDR-safe Together) is visible, instead of
    // a quiet no-op that looks like the cutover took effect.
    if (mode === "cutover" && !secondary) {
      console.warn(
        "[TerosFallback] mode=cutover but no Together target available — running Fireworks " +
          "(check the together system secret + ZDR classification in data-retention.ts)",
      )
    }
  }

  async streamMessage(options: StreamMessageOptions): Promise<LLMResponse> {
    // Hard cutover: skip Fireworks entirely (only when a target exists).
    if (this.mode === "cutover" && this.secondary) {
      return this.secondary.streamMessage(options)
    }

    // Track whether the primary streamed anything, so we never fail over after
    // user-visible output (would duplicate it on the secondary).
    let emitted = false
    const markEmitted = () => {
      emitted = true
    }
    const guarded: StreamMessageOptions = {
      ...options,
      callbacks: {
        ...options.callbacks,
        onText: async (chunk) => {
          markEmitted()
          await options.callbacks?.onText?.(chunk)
        },
        onToolCall: async (toolCall) => {
          markEmitted()
          await options.callbacks?.onToolCall?.(toolCall)
        },
        // R8.4: thinking output / text-end also count as "produced output" so we
        // never fail over mid-stream if Kimi's thinking channel gets wired.
        onThinking: async (chunk) => {
          markEmitted()
          await options.callbacks?.onThinking?.(chunk)
        },
        onTextEnd: async () => {
          markEmitted()
          await options.callbacks?.onTextEnd?.()
        },
      },
    }

    try {
      return await this.primary.streamMessage(guarded)
    } catch (err) {
      if (this.mode === "on-error" && this.secondary && !emitted && isFailoverWorthy(err)) {
        const errorClass = (err as { context?: { errorClass?: unknown } })?.context?.errorClass
        const primaryErrorClass = String(errorClass ?? "transient")
        console.warn(
          `[TerosFallback] Fireworks failed (${primaryErrorClass}) before output — failing over to Together`,
        )
        // R3.1: tag the secondary's onFinish so the turn is counted as a failover
        // (fallbackUsed → fallback-rate, F1) AND the primary's failure survives in
        // the error-rate (primaryProvider/primaryErrorClass, bucketed under
        // fireworks by the rollup). Without this the secondary's onFinish would
        // overwrite the primary's and the Fireworks failure would be invisible.
        const failoverOptions: StreamMessageOptions = {
          ...options,
          callbacks: {
            ...options.callbacks,
            onFinish: async (info) => {
              await options.callbacks?.onFinish?.({
                ...info,
                fallbackUsed: true,
                primaryProvider: "fireworks",
                primaryErrorClass,
              })
            },
          },
        }
        return await this.secondary.streamMessage(failoverOptions)
      }
      throw err
    }
  }

  getProviderInfo() {
    const active = this.mode === "cutover" && this.secondary ? this.secondary : this.primary
    return active.getProviderInfo()
  }
}
