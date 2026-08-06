/**
 * Session-trace assembler (F2 / TER-643).
 *
 * Pure function that weaves a single turn's raw records — the session, its LLM
 * calls, its tool executions, the message text behind each LLM call, the 👍/👎
 * feedback, and the direct subagent sessions — into one chronologically ordered
 * trace the `SessionTraceView` renders. No DB: the handler does the queries,
 * this does the assembly, so it is fully unit-testable / mutation-verifiable.
 *
 * Joins (verified against the LIVE schema via smoke, not the stale `messages`
 * collection the design doc assumed):
 *   - tool_executions / llm_usage → session via `sessionUsageId`.
 *   - llm_usage → **channel_messages** via `messageId == channel_messages.messageId`
 *     (the assistant message this call produced). The text lives in `content`
 *     (a `MessageContent` union: `{type:'text', text}` for the common case) —
 *     NOT in `messages.parts[]` (that collection is empty/legacy here).
 *   - message_feedback → the SAME `messageId`.
 *   - subagents → this session via `parentSessionUsageId`.
 */

import type {
  AgentUsageSession,
  LLMUsage,
  MessageFeedback,
  ToolExecution,
} from "../types/database.js"

/**
 * The slice of a `channel_messages` doc the trace needs. `timestamp` is an ISO
 * STRING in the live data (not a Date) — the type reflects that; `toEpoch`
 * tolerates Date/number too.
 */
export interface TraceChannelMessage {
  messageId: string
  role: string
  content?: { type?: string; text?: string } & Record<string, unknown>
  timestamp?: Date | string | number
}

export interface TraceMessage {
  id: string
  role: string
  createdAt: number | null
  /** Text when `content.type === 'text'`; null for non-text content. */
  text: string | null
  /** `content.type` (text | image | file | tool_execution | …). */
  contentType: string
}

export interface TraceLlmCall {
  usageId: string
  step: number | null
  provider: string
  actualProvider?: string
  modelId: string
  actualModel?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens?: number
  costTotal: number
  latencyMs?: number
  ttftMs?: number
  stopReason?: string
  fallbackUsed?: boolean
  messageId: string
  /** Text/parts of the message this call produced (`messages.info.id`). null if absent. */
  message: TraceMessage | null
  /** 👍/👎 on that message, if any. */
  feedback: { rating: "up" | "down"; comment?: string; reasons?: string[] } | null
}

export interface TraceToolCall {
  toolExecutionId: string
  stepIndex: number
  toolCallIndex: number
  toolName: string
  mcaId?: string
  status: ToolExecution["status"]
  durationMs: number | null
  errorMessage?: string
  inputSizeBytes?: number
  outputSizeBytes?: number
}

export type TraceEvent =
  | { kind: "llm"; at: Date; llm: TraceLlmCall }
  | { kind: "tool"; at: Date; tool: TraceToolCall }

/** A direct subagent session (one level), for the delegation tree. */
export interface TraceChild {
  sessionUsageId: string
  agentId: string
  /** Resolved agent display name; absent if the agent was deleted (P6). */
  agentName?: string
  triggerKind: AgentUsageSession["triggerKind"]
  status: AgentUsageSession["status"]
  modelId: string
  actualProvider?: string
  totalTokens: number
  costUsd: number
  /** Execution start; null while the child is still queued (TER-650/G1). */
  startedAt: Date | null
  durationMs: number | null
}

export interface SessionTrace {
  session: AgentUsageSession
  /**
   * Resolved display names (2026-07-07 monitoring audit, P6). The backend
   * resolves ids → names (repo pattern: handlers return data, the frontend
   * composes the phrase); absent when the entity no longer exists — the UI
   * falls back to the raw id honestly.
   */
  agentName?: string
  userName?: string
  workspaceName?: string
  /** LLM + tool events interleaved in chronological order. */
  events: TraceEvent[]
  /** Direct subagents (parentSessionUsageId === this session). */
  children: TraceChild[]
}

/**
 * Sort key for an event: chronological first, then a stable tiebreaker so a
 * deterministic order survives equal timestamps. LLM calls of a step sort
 * before that step's tools (subIndex 0 vs toolCallIndex+1).
 */
function llmSortKey(u: LLMUsage): [number, number, number] {
  return [u.timestamp.getTime(), u.step ?? 0, 0]
}
function toolSortKey(t: ToolExecution): [number, number, number] {
  return [t.startedAt.getTime(), t.stepIndex, t.toolCallIndex + 1]
}
function cmpKey(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

type KeyedEvent = TraceEvent & { _k: [number, number, number] }

/** Coerce a Mongo timestamp (ISO string in the live data, sometimes Date/number) to epoch ms. */
function toEpoch(t: Date | string | number | undefined): number | null {
  if (t == null) return null
  if (t instanceof Date) return t.getTime()
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

function toTraceMessage(cm: TraceChannelMessage, redactText: boolean): TraceMessage {
  const type = cm.content?.type ?? "unknown"
  return {
    id: cm.messageId,
    role: cm.role,
    createdAt: toEpoch(cm.timestamp),
    // PII gate (TER-671/A6.3): the conversation text is super-only. A non-super
    // admin still sees the message's shape (role, contentType, timing) and all
    // the structural trace (timings/tokens/tools/feedback) — just not the
    // plaintext the founding partner wrote or the agent replied.
    text: redactText ? null : type === "text" ? (cm.content?.text ?? null) : null,
    contentType: type,
  }
}

function buildLlmEvent(
  u: LLMUsage,
  channelMessageById: Map<string, TraceChannelMessage>,
  feedbackByMessageId: Map<string, MessageFeedback>,
  redactText: boolean,
): KeyedEvent {
  const cm = channelMessageById.get(u.messageId)
  const fb = feedbackByMessageId.get(u.messageId)
  return {
    _k: llmSortKey(u),
    kind: "llm",
    at: u.timestamp,
    llm: {
      usageId: u.usageId,
      step: u.step ?? null,
      provider: u.provider,
      actualProvider: u.actualProvider,
      modelId: u.modelId,
      actualModel: u.actualModel,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.totalTokens,
      reasoningTokens: u.reasoningTokens,
      costTotal: u.costTotal,
      latencyMs: u.latencyMs,
      ttftMs: u.ttftMs,
      stopReason: u.stopReason,
      fallbackUsed: u.fallbackUsed,
      messageId: u.messageId,
      message: cm ? toTraceMessage(cm, redactText) : null,
      feedback: fb ? { rating: fb.rating, comment: fb.comment, reasons: fb.reasons } : null,
    },
  }
}

function buildToolEvent(t: ToolExecution): KeyedEvent {
  return {
    _k: toolSortKey(t),
    kind: "tool",
    at: t.startedAt,
    tool: {
      toolExecutionId: t.toolExecutionId,
      stepIndex: t.stepIndex,
      toolCallIndex: t.toolCallIndex,
      toolName: t.toolName,
      mcaId: t.mcaId,
      status: t.status,
      durationMs: t.durationMs,
      errorMessage: t.errorMessage,
      inputSizeBytes: t.inputSizeBytes,
      outputSizeBytes: t.outputSizeBytes,
    },
  }
}

function buildChild(d: AgentUsageSession): TraceChild {
  return {
    sessionUsageId: d.sessionUsageId,
    agentId: d.agentId,
    triggerKind: d.triggerKind,
    status: d.status,
    modelId: d.modelId,
    actualProvider: d.actualProvider,
    totalTokens: d.totalTokens,
    costUsd: d.costUsd,
    startedAt: d.startedAt,
    durationMs: d.durationMs,
  }
}

export function assembleSessionTrace(input: {
  session: AgentUsageSession
  toolExecutions: ToolExecution[]
  llmUsages: LLMUsage[]
  /** `channel_messages` docs keyed in by the handler (joined on `messageId`). */
  channelMessages: TraceChannelMessage[]
  feedback: MessageFeedback[]
  descendants: AgentUsageSession[]
  /** Optional resolved names, keyed by id (P6). Missing ids fall back to raw. */
  names?: {
    agentNameById?: Map<string, string>
    userName?: string
    workspaceName?: string
  }
  /** Null out the conversation text (non-super admins) — TER-671/A6.3. */
  redactText?: boolean
}): SessionTrace {
  const channelMessageById = new Map(input.channelMessages.map((m) => [m.messageId, m]))
  const feedbackByMessageId = new Map(input.feedback.map((f) => [f.messageId, f]))
  const redactText = input.redactText ?? false

  const events: KeyedEvent[] = [
    ...input.llmUsages.map((u) =>
      buildLlmEvent(u, channelMessageById, feedbackByMessageId, redactText),
    ),
    ...input.toolExecutions.map(buildToolEvent),
  ]
  events.sort((a, b) => cmpKey(a._k, b._k))

  const agentNameById = input.names?.agentNameById
  const children = input.descendants
    // dev: enrich each child with its resolved agentName (session-detail view).
    .map((d) => ({ ...buildChild(d), agentName: agentNameById?.get(d.agentId) }))
    // A still-queued child has no execution anchor yet — sort it ahead of
    // started children (it enqueued before any of them ran). The null-safe
    // getTime is load-bearing: a queued child's startedAt is null. TER-650/G1.
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))

  return {
    session: input.session,
    agentName: agentNameById?.get(input.session.agentId),
    userName: input.names?.userName,
    workspaceName: input.names?.workspaceName,
    events: events.map(({ _k, ...e }) => e),
    children,
  }
}

// ============================================================================
// F3a — Telemetry contract for the Latitude OTLP export
// ============================================================================
//
// `AgentTurnTelemetry` is a STABLE contract, deliberately independent of the F2
// view-model (`SessionTrace`) above. The view-model exists to render a window
// and will churn with UI needs; the OTLP emitter must NOT ride that churn
// (adversarial finding M-I). It also carries what the view-model omits but the
// export needs: **per-call cache tokens** and **per-call provider/actualProvider**
// (the latter feeds the per-call ZDR guard of F3b, adversarial finding C2).
//
// NO text / content: F3a is structure-only. `assembleTurnTelemetry` therefore
// needs neither `channel_messages` nor `message_feedback` — cheaper to gather
// in the post-session hook than the full view-model query set.
//
// The snapshot test anchors to these types: a field rename here is a wire
// change and must fail the snapshot loudly.

/** Session-level telemetry → the root `invoke_agent` span. */
export interface TurnSessionTelemetry {
  sessionUsageId: string
  parentSessionUsageId: string | null
  /**
   * Root of the delegation tree (denormalized on the doc; falls back to
   * `sessionUsageId` for legacy rows). Anchors the tree-wide `traceId` so every
   * session of a delegation chain lands in ONE Latitude trace.
   */
  rootSessionUsageId: string
  triggerKind: AgentUsageSession["triggerKind"]
  userId: string
  agentId: string
  workspaceId: string
  channelId: string
  coreId?: string
  /** Logical provider alias (e.g. `teros`). */
  provider: string
  /** Real upstream that served the turn (e.g. `fireworks`). */
  actualProvider?: string
  modelId: string
  actualModel?: string
  startedAt: Date | null
  endedAt: Date | null
  durationMs: number | null
  status: AgentUsageSession["status"]
  errorKind?: AgentUsageSession["errorKind"]
  llmCallCount: number
  toolCallCount: number
  costUsd: number
}

/** One LLM call → a `chat` span. Carries the usage (which lives ONLY here). */
export interface TurnLlmTelemetry {
  usageId: string
  step: number | null
  provider: string
  /** Per-call upstream — the ZDR guard (F3b) evaluates retention per call (C2). */
  actualProvider?: string
  modelId: string
  actualModel?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /**
   * Per-call cache tokens (M-I). Defaulted to 0 when the provider does not
   * report caching. Field name follows `LLMUsage` (`cache*`), which is the
   * source; the session doc spells it `cached*` — the mismatch is pre-existing.
   */
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costTotal: number
  latencyMs?: number
  ttftMs?: number
  /** `finish_reasons` as an ARRAY (OTel semconv), derived from the singular `stopReason`. */
  finishReasons: string[]
  fallbackUsed?: boolean
  messageId: string
  timestamp: Date
}

/** One tool execution → an `execute_tool` span. */
export interface TurnToolTelemetry {
  toolExecutionId: string
  stepIndex: number
  toolCallIndex: number
  toolName: string
  mcaId?: string
  status: ToolExecution["status"]
  startedAt: Date | null
  durationMs: number | null
  errorMessage?: string
  inputSizeBytes?: number
  outputSizeBytes?: number
}

export interface AgentTurnTelemetry {
  session: TurnSessionTelemetry
  /** LLM calls, chronological. */
  llmCalls: TurnLlmTelemetry[]
  /** Tool executions, chronological. */
  toolCalls: TurnToolTelemetry[]
}

function toTurnLlm(u: LLMUsage): TurnLlmTelemetry {
  return {
    usageId: u.usageId,
    step: u.step ?? null,
    provider: u.provider,
    actualProvider: u.actualProvider,
    modelId: u.modelId,
    actualModel: u.actualModel,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: u.totalTokens,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheWriteTokens: u.cacheWriteTokens ?? 0,
    reasoningTokens: u.reasoningTokens ?? 0,
    costTotal: u.costTotal,
    latencyMs: u.latencyMs,
    ttftMs: u.ttftMs,
    finishReasons: u.stopReason ? [u.stopReason] : [],
    fallbackUsed: u.fallbackUsed,
    messageId: u.messageId,
    timestamp: u.timestamp,
  }
}

function toTurnTool(t: ToolExecution): TurnToolTelemetry {
  return {
    toolExecutionId: t.toolExecutionId,
    stepIndex: t.stepIndex,
    toolCallIndex: t.toolCallIndex,
    toolName: t.toolName,
    mcaId: t.mcaId,
    status: t.status,
    startedAt: t.startedAt,
    durationMs: t.durationMs,
    errorMessage: t.errorMessage,
    inputSizeBytes: t.inputSizeBytes,
    outputSizeBytes: t.outputSizeBytes,
  }
}

/**
 * Pure assembly of a turn's raw records into the stable telemetry contract.
 * No DB, no text — the post-session export hook does the (structure-only)
 * queries and hands the rows here. Fully unit-testable / mutation-verifiable.
 *
 * `rootSessionUsageId` falls back to `sessionUsageId` when the doc predates the
 * denormalization (legacy top-level turns are correct; F3a is forward-only so
 * delegated children always carry the real root).
 */
export function assembleTurnTelemetry(input: {
  session: AgentUsageSession
  llmUsages: LLMUsage[]
  toolExecutions: ToolExecution[]
}): AgentTurnTelemetry {
  const { session } = input

  const llmCalls = [...input.llmUsages]
    .sort((a, b) => cmpKey(llmSortKey(a), llmSortKey(b)))
    .map(toTurnLlm)
  const toolCalls = [...input.toolExecutions]
    .sort((a, b) => cmpKey(toolSortKey(a), toolSortKey(b)))
    .map(toTurnTool)

  return {
    session: {
      sessionUsageId: session.sessionUsageId,
      parentSessionUsageId: session.parentSessionUsageId,
      rootSessionUsageId: session.rootSessionUsageId ?? session.sessionUsageId,
      triggerKind: session.triggerKind,
      userId: session.userId,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
      channelId: session.channelId,
      coreId: session.coreId,
      provider: session.provider,
      actualProvider: session.actualProvider,
      modelId: session.modelId,
      actualModel: session.actualModel,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: session.durationMs,
      status: session.status,
      errorKind: session.errorKind,
      llmCallCount: session.llmCallCount,
      toolCallCount: session.toolCallCount,
      costUsd: session.costUsd,
    },
    llmCalls,
    toolCalls,
  }
}
