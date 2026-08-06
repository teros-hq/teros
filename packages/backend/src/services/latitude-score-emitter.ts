/**
 * Latitude score emitter (F4 · C0 — the "signals" enabler).
 *
 * Latitude grows `signals` (clustered issues) out of SCORES that fail — not out
 * of traces. This service turns Teros' own failure signals (a user 👎, a
 * turn whose tools errored) into a `POST /v1/projects/{slug}/scores` against the
 * matching Latitude trace, so the clustering pipeline has something to cluster.
 *
 * Four invariants, all mirrored from F3a's export seam (do not weaken any):
 *
 *  1. NO CONTENT. `feedback` is a CATEGORICAL token (`"thumbs_down"` /
 *     `"tool_error"`), NEVER the user's comment or an error message, and
 *     `metadata` holds only ids + the reason enum. The scores endpoint requires
 *     `feedback: string`; a token satisfies it without re-opening the text-egress
 *     channel F3a closed. Message text stays behind F3b + legal (adversarial
 *     finding C-1).
 *
 *  2. NO ZDR GATE (categorical scores are content-free). A categorical failure
 *     token + ids is structurally identical, in data-exposure terms, to F3a's
 *     structure-only trace export — which is NOT ZDR-gated (the ZDR guard is
 *     reserved for F3b, when message TEXT enters). Gating scores on ZDR was
 *     inconsistent (F3a still exported the ZDR turn's trace, but C0 withheld its
 *     matching score → an orphan trace) and over-conservative: ZDR describes what
 *     the model PROVIDER does with content, not a Teros-generated failure label.
 *     So scores emit for EVERY turn, including the default `teros` (ZDR). Text —
 *     and its per-call ZDR guard — stays behind F3b + legal.
 *
 *  3. TRACE MATCH via `traceIdFor(rootSessionUsageId)` — the SAME 32-hex helper
 *     the span-builder stamps on the exported trace (never the native
 *     `session_*` id). Shared derivation = the score pins to the right trace
 *     (adversarial finding M-1 + the anti-meaning-drift guard).
 *
 *  4. FIRE-AND-FORGET seam. `emit*` returns synchronously, never throws, never
 *     rejects into the caller. A concurrency cap drops excess work best-effort
 *     (telemetry, not billing). Latitude down → the product is byte-identical.
 *
 * Deferred retry: the score endpoint resolves session/span FROM the trace, so a
 * `trace.by:"id"` lookup 404s with "Trace not found" until the trace has flushed
 * (F3a's BatchSpanProcessor batches on a 5 s cadence, then ingest→ClickHouse adds
 * more). We therefore delay the first POST past the flush window and retry ONLY on
 * `trace_not_found` / `rate_limited` — both guarantee the score was NOT written,
 * so the retry cannot duplicate. Network/5xx are uncertain → dropped, never
 * retried blindly (POST is not idempotent otherwise).
 */

import type { Db } from "mongodb"
import type { Logger } from "pino"
import type { AgentUsageSession, LLMUsage } from "../types/database.js"
import { traceIdFor } from "./otel-span-builder.js"

/** Categorical, content-free score reasons wired in C0. Extend additively. */
export type ScoreReason = "thumbs_down" | "tool_error"

/** Exact request body of `POST /v1/projects/{slug}/scores` (custom score). */
export interface ScoreSubmitPayload {
  value: number
  passed: boolean
  /** Categorical token — NOT free text. */
  feedback: string
  sourceId: string
  trace: { by: "id"; id: string }
  metadata: Record<string, string | number | boolean>
}

/**
 * Transport outcome, discriminated so the emitter can decide retry safety
 * without re-reading HTTP status. `trace_not_found` and `rate_limited` mean the
 * score was NOT persisted (safe to retry); `error` is uncertain (drop).
 */
export type ScoreSubmitResult =
  | { kind: "ok" }
  | { kind: "trace_not_found" }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "error"; status?: number }

/**
 * The one vendor-facing seam (soberanía Principio 3): the ONLY thing that talks
 * to the Latitude scores wire. Swapping targets is a diff to the factory below;
 * the emitter never changes.
 */
export interface ScoreClient {
  submit(payload: ScoreSubmitPayload): Promise<ScoreSubmitResult>
}

export interface LatitudeScoreClientConfig {
  /** API base, e.g. `http://localhost:3011` — the REST API, NOT the OTLP ingest. */
  apiBaseUrl: string
  /** Bearer secret (same org API key as the OTLP ingest). */
  token: string
  /** Project slug (path segment). */
  project: string
  /** Per-request timeout (ms). Default 10 000. */
  timeoutMs?: number
}

const RETRY_AFTER_CAP_MS = 30_000

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return undefined // absolute date — fall back to the emitter default
  return undefined
}

/**
 * Real transport. Pure factory (reads no env) so it is unit-testable against a
 * fake endpoint. The `fetch` here is the only network call in C0 — the
 * sovereignty grep-guard allowlists this module to the wiring only.
 */
export function createLatitudeScoreClient(config: LatitudeScoreClientConfig): ScoreClient {
  const base = config.apiBaseUrl.replace(/\/+$/, "")
  const url = `${base}/v1/projects/${encodeURIComponent(config.project)}/scores`
  const timeoutMs = config.timeoutMs ?? 10_000

  return {
    async submit(payload: ScoreSubmitPayload): Promise<ScoreSubmitResult> {
      let res: Response
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        // Network error / timeout: uncertain whether the server wrote anything.
        return { kind: "error" }
      }

      if (res.status === 201) return { kind: "ok" }
      if (res.status === 429) {
        return {
          kind: "rate_limited",
          retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
        }
      }
      if (res.status === 400 || res.status === 404) {
        // The trace may not have flushed to ClickHouse yet — the common case,
        // since the exporter's BatchSpanProcessor delays ~5s and ClickHouse
        // ingest is async. Latitude answers the `trace.by:"id"` lookup C0 uses
        // with 404 {"error":"Trace not found"} (verified against the live REST
        // API), and the filter/session-resolution path with 400 "Trace not found
        // for score". Both are the transient race → retriable. Any OTHER 400/404
        // (malformed body, unknown project) is a genuine bad request → drop.
        // Distinguish by body so we never retry a truly bad request forever.
        const body = await res.text().catch(() => "")
        if (/trace not found/i.test(body)) return { kind: "trace_not_found" }
        return { kind: "error", status: res.status }
      }
      return { kind: "error", status: res.status }
    },
  }
}

/** Health counters for the seam — mirrored to /metrics (see latitude-score-metrics.ts). */
export interface LatitudeScoreMetrics {
  recordEmitted(reason: ScoreReason): void
  recordDelivered(): void
  recordDropped(cause: "cap" | "error" | "trace_not_found" | "rate_limited"): void
  recordTraceNotFoundRetry(): void
  setInFlight(n: number): void
}

/** Minimal projection of the session a score pins to. */
interface SessionRef {
  sessionUsageId: string
  rootSessionUsageId: string
  provider: string
  actualProvider: string | null
  workspaceId: string
  agentId: string
  toolErrorCount: number
}

export interface LatitudeScoreEmitterDeps {
  db: Db
  client: ScoreClient
  /** Sync, O(1) over the flag cache. Resolved per emit — cheap; short-circuits queries when off. */
  isEnabled: () => boolean
  log: Logger
  /** `sourceId` tag on every score. Default `"teros-runtime"` (distinct from C3's `ci-<sha>`). */
  sourceId?: string
  /** Max in-flight emit chains (each holds a timer for seconds). Default 64. Excess dropped. */
  maxConcurrency?: number
  /** Delay before the first POST, past F3a's ~5 s trace flush. Default 7 000. */
  initialDelayMs?: number
  /** Delay between deferred retries. Default 7 000. */
  retryDelayMs?: number
  /** Retries after the first attempt (so attempts = maxRetries + 1). Default 2. */
  maxRetries?: number
  /** Injectable for deterministic tests. Default real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>
  metrics?: LatitudeScoreMetrics
}

export class LatitudeScoreEmitter {
  private inFlight = 0
  private readonly sourceId: string
  private readonly maxConcurrency: number
  private readonly initialDelayMs: number
  private readonly retryDelayMs: number
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: LatitudeScoreEmitterDeps) {
    this.sourceId = deps.sourceId ?? "teros-runtime"
    this.maxConcurrency = deps.maxConcurrency ?? 64
    this.initialDelayMs = deps.initialDelayMs ?? 7_000
    this.retryDelayMs = deps.retryDelayMs ?? 7_000
    this.maxRetries = deps.maxRetries ?? 2
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * Score a message 👎. No-op for 👍 (only failures grow signals). Resolves the
   * turn from the message via `llm_usage.messageId`.
   */
  emitMessageFeedback(input: { messageId: string; rating: "up" | "down" }): void {
    if (input.rating !== "down") return
    this.enqueue(async () => {
      const ref = await this.resolveFromMessage(input.messageId)
      return ref ? { ref, reason: "thumbs_down" as const } : null
    })
  }

  /**
   * Score a finished turn that had tool errors. Called from the applier's
   * `onSessionEnded` (after the idempotency `matched`, alongside `exportTurn`) so
   * the trace this pins to has been handed to the exporter — NOT per tool in
   * `onToolEnded`, which would fire before the trace exists and N× per turn.
   */
  emitSessionFailure(input: { sessionUsageId: string }): void {
    this.enqueue(async () => {
      const ref = await this.resolveFromSession(input.sessionUsageId)
      if (!ref || ref.toolErrorCount <= 0) return null
      return { ref, reason: "tool_error" as const }
    })
  }

  private enqueue(resolve: () => Promise<{ ref: SessionRef; reason: ScoreReason } | null>): void {
    if (!this.deps.isEnabled()) return
    if (this.inFlight >= this.maxConcurrency) {
      this.deps.metrics?.recordDropped("cap")
      return
    }
    this.inFlight++
    this.deps.metrics?.setInFlight(this.inFlight)
    void this.process(resolve).finally(() => {
      this.inFlight--
      this.deps.metrics?.setInFlight(this.inFlight)
    })
  }

  private async process(
    resolve: () => Promise<{ ref: SessionRef; reason: ScoreReason } | null>,
  ): Promise<void> {
    try {
      const resolved = await resolve()
      if (!resolved) return
      const { ref, reason } = resolved
      const payload = this.buildPayload(ref, reason)
      this.deps.metrics?.recordEmitted(reason)
      await this.deliverWithRetry(payload)
    } catch (err) {
      // Never propagate — Latitude problems must not touch the product path.
      this.deps.log.warn({ err }, "latitude score emit failed")
      this.deps.metrics?.recordDropped("error")
    }
  }

  private buildPayload(ref: SessionRef, reason: ScoreReason): ScoreSubmitPayload {
    return {
      value: 0,
      passed: false,
      feedback: reason, // categorical token, never content
      sourceId: this.sourceId,
      trace: { by: "id", id: traceIdFor(ref.rootSessionUsageId) },
      metadata: {
        reason,
        session_id: ref.sessionUsageId,
        root_session_id: ref.rootSessionUsageId,
        workspace_id: ref.workspaceId,
        agent_id: ref.agentId,
        // Enums, not content — lets signals be sliced by which provider failed.
        provider: ref.provider,
        actual_provider: ref.actualProvider ?? ref.provider,
      },
    }
  }

  private async deliverWithRetry(payload: ScoreSubmitPayload): Promise<void> {
    // Wait out the trace flush before the first attempt.
    await this.sleep(this.initialDelayMs)
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const result = await this.deps.client.submit(payload)
      if (result.kind === "ok") {
        this.deps.metrics?.recordDelivered()
        return
      }
      const canRetry = attempt < this.maxRetries
      if (result.kind === "trace_not_found" && canRetry) {
        this.deps.metrics?.recordTraceNotFoundRetry()
        await this.sleep(this.retryDelayMs)
        continue
      }
      if (result.kind === "rate_limited" && canRetry) {
        await this.sleep(Math.min(result.retryAfterMs ?? this.retryDelayMs, RETRY_AFTER_CAP_MS))
        continue
      }
      this.deps.metrics?.recordDropped(
        result.kind === "trace_not_found" ? "trace_not_found" : "error",
      )
      return
    }
  }

  private async resolveFromMessage(messageId: string): Promise<SessionRef | null> {
    const usage = await this.deps.db
      .collection<LLMUsage>("llm_usage")
      .findOne({ messageId }, { projection: { sessionUsageId: 1 } })
    if (!usage?.sessionUsageId) return null
    return this.resolveFromSession(usage.sessionUsageId)
  }

  private async resolveFromSession(sessionUsageId: string): Promise<SessionRef | null> {
    const s = await this.deps.db
      .collection<AgentUsageSession>("agent_usage_sessions")
      .findOne({ sessionUsageId })
    if (!s) return null
    return {
      sessionUsageId,
      rootSessionUsageId: s.rootSessionUsageId ?? sessionUsageId,
      provider: s.provider,
      actualProvider: s.actualProvider ?? null,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      toolErrorCount: s.toolErrorCount ?? 0,
    }
  }

  /**
   * Bounded drain on shutdown. Most in-flight chains are parked in their deferred
   * delay (seconds) and WILL be abandoned here — that is the declared best-effort
   * loss window for telemetry. Just don't hang the process.
   */
  async shutdown(): Promise<void> {
    const deadline = Date.now() + 2_000
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
