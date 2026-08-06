/**
 * Domain service for agent usage sessions.
 *
 * Coordinates the lifecycle of a session by:
 *   1. Generating ids and capturing monotonic timestamps.
 *   2. Building event payloads.
 *   3. Emitting events through the UsageEventBuffer.
 *
 * The caller (message-handler.processAgentResponse) wraps the turn in
 * `usageContext.run({ sessionUsageId }, async () => …)` so child turns
 * triggered via delegation can recover the parent id via AsyncLocalStorage.
 *
 * Error classification: `classifyError(err)` maps `AgentError.type` (and
 * stringified errors) to AgentUsageErrorKind. Exported for reuse by
 * `agent-loop.ts:handleAgentError`.
 *
 *
 */

import { generateSessionUsageId, generateUsageEventId } from "@teros/core"
import type {
  AgentUsageDurationSource,
  AgentUsageErrorKind,
  AgentUsageSessionStatus,
  AgentUsageTriggerKind,
  LLMUsage,
  SessionDeltaPayload,
} from "../types/database.js"
import { sanitizeErrorMessage } from "./agent-usage-pii-sanitizer.js"
import type { UsageEventBuffer } from "./usage-event-buffer.js"

/**
 * Snapshot returned by `start()` to be stored in the caller's closure and
 * passed back to `end()`.
 */
export interface SessionUsageHandle {
  sessionUsageId: string
  /** Monotonic clock at enqueue time (session opened, still `queued`). */
  monoStart: number
  /** Wall-clock at enqueue time. */
  wallStart: Date
  /**
   * Monotonic clock captured when the turn actually STARTED executing
   * (`markRunning`), so `end()` measures execution time (NTP-safe), excluding
   * the queue wait (TER-650/G1). Undefined until `markRunning` fires; a session
   * that ends without ever running (e.g. cancelled while queued) has no
   * execution duration → `end()` reports `durationMs=0`.
   */
  execMonoStart?: number
  /**
   * Captured at start so `end()` can emit it without re-querying the doc.
   * Used by the applier to gate descendant-counter propagation.
   */
  parentSessionUsageId: string | null
  /** Delegation-tree root (F3a). Used to scope the AsyncLocalStorage for children. */
  rootSessionUsageId: string
}

export interface StartSessionInput {
  parentSessionUsageId: string | null
  /**
   * Root of the delegation tree, inherited from the parent for a delegated
   * child (F3a). Omit for a top-level turn — `start()` seeds it to the freshly
   * generated `sessionUsageId`.
   */
  rootSessionUsageId?: string
  triggerKind: AgentUsageTriggerKind
  userId: string
  agentId: string
  workspaceId: string
  channelId: string
  coreId?: string
  provider: LLMUsage["provider"]
  modelId: string
  /**
   * Expected upstream + model, pre-computed so error/timeout turns (no
   * `session.delta`) still bucket under the real upstream, not the logical
   * `provider` alias (TER-616/C1). Omitted for providers without a split.
   */
  actualProvider?: string
  actualModel?: string
}

export interface EndSessionInput {
  handle: SessionUsageHandle
  status: AgentUsageSessionStatus
  /** Optional override for durationSource (default 'monotonic'). */
  durationSource?: AgentUsageDurationSource
  /** Optional. Will be sanitized + truncated before emission. */
  errorKind?: AgentUsageErrorKind
  errorMessage?: unknown
  /**
   * Honest-attribution sub-reason from the adapter (`context.errorSubReason`,
   * TER-698) — capacity vs billing vs missing model, etc. Ops-only; never shown
   * to the user. A safe enum string, not sanitized.
   */
  errorSubReason?: string
  /**
   * The literal upstream provider message (`context.upstreamMessage`, TER-698),
   * preserved verbatim for the ops feed. Sanitized + truncated before emission.
   */
  upstreamMessage?: unknown
}

export class AgentUsageSessionService {
  constructor(private readonly buffer: UsageEventBuffer) {}

  /**
   * Open a new session in the `queued` state. Emits `session.started`; the
   * session does NOT bill until `markRunning` flips it to `running` with an
   * execution-anchored `startedAt` (TER-650/G1). Returns a handle the caller
   * passes to `markRunning` (on turn start) and `end()` (on turn close).
   */
  start(input: StartSessionInput): SessionUsageHandle {
    const sessionUsageId = generateSessionUsageId()
    const monoStart = performance.now()
    const wallStart = new Date()
    // Top-level turn → the session is its own tree root; delegated child →
    // inherit the root the caller propagated (F3a, one traceId per tree).
    const rootSessionUsageId = input.rootSessionUsageId ?? sessionUsageId

    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId,
      type: "session.started",
      payload: {
        parentSessionUsageId: input.parentSessionUsageId,
        rootSessionUsageId,
        triggerKind: input.triggerKind,
        userId: input.userId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        coreId: input.coreId,
        provider: input.provider,
        modelId: input.modelId,
        ...(input.actualProvider ? { actualProvider: input.actualProvider } : {}),
        ...(input.actualModel ? { actualModel: input.actualModel } : {}),
        startedAt: wallStart,
      },
      appliedAt: wallStart,
      schemaVersion: 1,
    })

    return {
      sessionUsageId,
      monoStart,
      wallStart,
      parentSessionUsageId: input.parentSessionUsageId,
      rootSessionUsageId,
    }
  }

  /**
   * Flip the session `queued → running`. Emits `session.running` with an
   * execution-anchored `startedAt` (now) and records the monotonic execution
   * start on the handle so `end()` measures execution time, not queue wait
   * (TER-650/G1). Idempotent-friendly: calling twice re-anchors, but the
   * applier's `{status:'queued'}` guard makes only the first emission take
   * effect on the projection. Mutates `handle.execMonoStart`.
   */
  markRunning(handle: SessionUsageHandle): void {
    handle.execMonoStart = performance.now()
    const startedAt = new Date()
    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId: handle.sessionUsageId,
      type: "session.running",
      payload: { startedAt },
      appliedAt: startedAt,
      schemaVersion: 1,
    })
  }

  /**
   * Append a delta of accumulated tokens. Called once per turn, after the
   * conversation loop has finished and the totals are known.
   */
  recordDelta(sessionUsageId: string, payload: SessionDeltaPayload): void {
    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId,
      type: "session.delta",
      payload,
      appliedAt: new Date(),
      schemaVersion: 1,
    })
  }

  /**
   * Close the session. `durationMs` measures EXECUTION time — `performance.now()
   * − handle.execMonoStart` (monotonic, NTP-safe) — so the queue wait is never
   * billed (TER-650/G1). A session that ended without ever running (no
   * `markRunning`) reports `durationMs=0`; it never bills anyway (0 tokens +
   * non-completed → `isNonBillableSession`).
   */
  end(input: EndSessionInput): void {
    const { handle } = input
    const endedAt = new Date()
    const monoEnd = performance.now()
    const durationMs =
      handle.execMonoStart != null
        ? Math.max(0, Math.round(monoEnd - handle.execMonoStart))
        : 0

    // A session never ends `queued` or `running` — normalize both to a clean
    // completion (the caller passes the raw turn outcome).
    const status: Exclude<AgentUsageSessionStatus, "running" | "queued"> =
      input.status === "running" || input.status === "queued"
        ? "completed"
        : input.status

    const errorMessage = sanitizeErrorMessage(input.errorMessage)
    const upstreamMessage = sanitizeErrorMessage(input.upstreamMessage)

    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId: handle.sessionUsageId,
      type: "session.ended",
      payload: {
        endedAt,
        durationMs,
        durationSource: input.durationSource ?? "monotonic",
        status,
        parentSessionUsageId: handle.parentSessionUsageId,
        ...(input.errorKind ? { errorKind: input.errorKind } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(input.errorSubReason ? { errorSubReason: input.errorSubReason } : {}),
        ...(upstreamMessage ? { upstreamMessage } : {}),
      },
      appliedAt: endedAt,
      schemaVersion: 1,
    })
  }
}

/**
 * Map any error to AgentUsageErrorKind.
 *
 * Internal to the agent usage subsystem. We duck-type on common error shapes
 * (`.type`, `.code`, `.name`, `.message`) to avoid importing AgentError from
 * `agent-loop.ts` (circular dep risk).
 *
 * NOTE: `handleAgentError` in `agent-loop.ts` keeps its own taxonomy
 * (`errorType: 'llm'|'tool'|'session'|'validation'|'network'|'unknown'`). The
 * two taxonomies are intentionally NOT shared — they serve different surfaces
 * (user-facing message vs telemetry). If they ever need to converge, factor
 * a third module with the canonical taxonomy and adapt both.
 */
/**
 * Map the adapter's structured `errorClass` (TER-615/F0, on `LLMError.context`)
 * to the usage error taxonomy. This is what lets the F1 model-health window
 * tell a rate-limit storm from a 5xx outage — the message/duck-typing below
 * cannot. Every provider limit class maps to a non-`unknown` kind (TER-698
 * closed the `not_found` gap so a retired/undeployed model no longer telemeters
 * as `unknown`); see the lint-as-test invariant in the service test.
 */
const ERROR_CLASS_TO_KIND: Partial<Record<string, AgentUsageErrorKind>> = {
  rate_limited: "rate_limited",
  overloaded: "overloaded",
  server_error: "server_error",
  spend_gate: "spend_gate",
  auth: "auth_error",
  connection: "network_error",
  not_found: "model_unavailable",
}

export function classifyError(err: unknown): AgentUsageErrorKind {
  if (!err || typeof err !== "object") return "unknown"

  // Prefer the adapter's structured errorClass when present (TER-615/F0).
  const ctxClass = (err as { context?: { errorClass?: unknown } }).context?.errorClass
  if (typeof ctxClass === "string") {
    const mapped = ERROR_CLASS_TO_KIND[ctxClass]
    if (mapped) return mapped
  }

  // Duck-typing on common shapes
  const e = err as { type?: string; name?: string; code?: string; message?: string }
  const tag = (e.type ?? e.code ?? e.name ?? "").toLowerCase()

  if (tag.includes("abort") || tag.includes("interrupt")) return "aborted_by_user"
  if (tag.includes("network") || tag.includes("fetch") || tag.includes("connect")) {
    return "network_error"
  }
  if (tag.includes("validation") || tag.includes("invalid")) return "validation_error"
  if (tag.includes("tool")) return "tool_error"
  if (tag.includes("llm") || tag.includes("model") || tag.includes("api_error")) {
    return "llm_error"
  }
  if (tag.includes("session")) return "session_error"

  // Heuristic on message
  const msg = (e.message ?? "").toLowerCase()
  if (msg.includes("interrupted by new message")) return "aborted_by_user"
  if (msg.includes("timeout")) return "reconciled_timeout"

  return "unknown"
}
