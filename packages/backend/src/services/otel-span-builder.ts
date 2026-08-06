/**
 * Pure span-builder for the Latitude OTLP export (F3a).
 *
 * Turns an `AgentTurnTelemetry` (the stable contract from the assembler) into a
 * flat list of `SpanDTO` — plain data, NOT live SDK spans (adversarial finding
 * M-J). The exporter (`otel-latitude-exporter.ts`) adapts these DTOs onto a
 * dedicated SDK provider. Keeping the tree pure makes it fully
 * mutation-verifiable with no OTel runtime.
 *
 * Hierarchy per turn: one `invoke_agent` root, one `chat` per LLM call, one
 * `execute_tool` per tool. A delegated turn's children are NOT summarized here
 * — each session exports its OWN sub-tree; the deterministic ids stitch the
 * sub-trees into one Latitude trace (adversarial finding M-B):
 *   - traceId  = f(rootSessionUsageId)           → the whole delegation tree shares it
 *   - spanId   = hash(sessionUsageId|kind|idx)   → stable, so re-export dedups in ClickHouse
 *   - parent of a chat/tool span = its session's invoke_agent span
 *   - parent of an invoke_agent span = the PARENT session's invoke_agent
 *     (absent at the tree root → top-level turn)
 *
 * Usage (`gen_ai.usage.*`) lives ONLY on `chat` spans, never on the root, so
 * Latitude's rollup does not double-count tokens (adversarial finding M-G).
 *
 * NO content: attribute values are ids, counts and timings — never message
 * text. F3b adds text behind a per-call ZDR guard; until then `includeContent`
 * is a fail-loud seam.
 *
 * Semconv: OTel GenAI (`gen_ai.provider.name`, not the deprecated
 * `gen_ai.system`). Keys are pinned against the digest smoke (pieza 10).
 */

import { createHash } from "node:crypto"
import { mapProviderToOtel } from "./agent-usage-otel-mapper.js"
import type {
  AgentTurnTelemetry,
  TurnLlmTelemetry,
  TurnSessionTelemetry,
  TurnToolTelemetry,
} from "./session-trace-assembler.js"

export type SpanAttrValue = string | number | boolean | string[]

/**
 * Flat, transport-agnostic representation of one span. Times are epoch millis;
 * the exporter converts to the SDK's HrTime (avoids nanosecond precision loss
 * of `ms * 1e6` in a JS double).
 */
export interface SpanDTO {
  /** 32 hex chars (16 bytes). Derived from `rootSessionUsageId` → tree-wide. */
  traceId: string
  /** 16 hex chars (8 bytes). */
  spanId: string
  /** 16 hex chars. Absent only for the trace root (a top-level invoke_agent). */
  parentSpanId?: string
  name: string
  /** All our spans are in-process. */
  kind: "INTERNAL"
  startEpochMs: number
  endEpochMs: number
  attributes: Record<string, SpanAttrValue>
  /** Set only on error (failed tool / errored session). */
  status?: { code: "ERROR"; message?: string }
}

export interface BuildSpanTreeOptions {
  /**
   * F3a is structure-only. This is the F3b seam (text behind the per-call ZDR
   * guard). It MUST be false until F3b lands — see the guard in `buildSpanTree`.
   */
  includeContent: boolean
}

const KIND_INVOKE_AGENT = "invoke_agent"
const KIND_CHAT = "chat"
const KIND_EXECUTE_TOOL = "execute_tool"

/** 16-byte trace id (32 hex) anchored on the delegation-tree root. */
export function traceIdFor(rootSessionUsageId: string): string {
  return createHash("sha256").update(`trace|${rootSessionUsageId}`).digest("hex").slice(0, 32)
}

/** 8-byte span id (16 hex), deterministic per (session, kind, index). */
export function spanIdFor(sessionUsageId: string, kind: string, idx: number): string {
  return createHash("sha256")
    .update(`span|${sessionUsageId}|${kind}|${idx}`)
    .digest("hex")
    .slice(0, 16)
}

function toEpochMs(t: Date | string | number | null | undefined): number | null {
  if (t == null) return null
  if (t instanceof Date) return t.getTime()
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/** Session statuses that mark the whole turn as failed. */
function isErroredStatus(status: TurnSessionTelemetry["status"]): boolean {
  return status === "errored" || status === "timed_out"
}

function buildRootSpan(
  s: TurnSessionTelemetry,
  rootAttrs: Record<string, SpanAttrValue>,
): SpanDTO {
  const start = toEpochMs(s.startedAt) ?? 0
  const end = toEpochMs(s.endedAt) ?? start + (s.durationMs ?? 0)

  const attributes: Record<string, SpanAttrValue> = {
    ...rootAttrs,
    "gen_ai.operation.name": KIND_INVOKE_AGENT,
    "gen_ai.provider.name": mapProviderToOtel(s.provider),
    "gen_ai.agent.id": s.agentId,
    "gen_ai.conversation.id": s.channelId,
    // Teros-owned correlation + upstream. NO gen_ai.usage.* here (M-G): tokens
    // live on the chat spans so Latitude does not double-count them.
    "teros.usage.session_id": s.sessionUsageId,
    "teros.usage.root_session_id": s.rootSessionUsageId,
    "teros.usage.trigger_kind": s.triggerKind,
    "teros.usage.workspace_id": s.workspaceId,
    "teros.usage.user_id": s.userId,
    "teros.usage.status": s.status,
    "teros.usage.duration_ms": s.durationMs ?? 0,
    "teros.usage.cost_usd": s.costUsd,
    "teros.usage.llm_call_count": s.llmCallCount,
    "teros.usage.tool_call_count": s.toolCallCount,
  }
  if (s.parentSessionUsageId) attributes["teros.usage.parent_session_id"] = s.parentSessionUsageId
  if (s.actualProvider) attributes["teros.usage.actual_provider"] = s.actualProvider
  if (s.coreId) attributes["teros.usage.core_id"] = s.coreId
  if (s.errorKind) attributes["teros.usage.error_kind"] = s.errorKind

  const span: SpanDTO = {
    traceId: traceIdFor(s.rootSessionUsageId),
    spanId: spanIdFor(s.sessionUsageId, KIND_INVOKE_AGENT, 0),
    name: KIND_INVOKE_AGENT,
    kind: "INTERNAL",
    startEpochMs: start,
    endEpochMs: end,
    attributes,
  }
  // A delegated turn hangs off its parent's invoke_agent; a top-level turn is
  // the trace root (no parent span).
  if (s.parentSessionUsageId) {
    span.parentSpanId = spanIdFor(s.parentSessionUsageId, KIND_INVOKE_AGENT, 0)
  }
  if (isErroredStatus(s.status)) {
    span.status = { code: "ERROR", ...(s.errorKind ? { message: s.errorKind } : {}) }
  }
  return span
}

function buildChatSpan(s: TurnSessionTelemetry, call: TurnLlmTelemetry, idx: number): SpanDTO {
  // The LLM timestamp marks the end of the generation; latency (if known) sets
  // the start so the span's duration reflects the call, not a zero-width point.
  const end = toEpochMs(call.timestamp) ?? toEpochMs(s.startedAt) ?? 0
  const start = end - (call.latencyMs ?? 0)

  const attributes: Record<string, SpanAttrValue> = {
    "gen_ai.operation.name": KIND_CHAT,
    "gen_ai.provider.name": mapProviderToOtel(call.provider),
    "gen_ai.request.model": call.modelId,
    "gen_ai.response.model": call.actualModel ?? call.modelId,
    // USAGE lives ONLY here (M-G): summed by Latitude across chat spans.
    "gen_ai.usage.input_tokens": call.promptTokens,
    "gen_ai.usage.output_tokens": call.completionTokens,
    "gen_ai.response.finish_reasons": call.finishReasons,
    "gen_ai.response.id": call.usageId,
    // Teros extensions (cache/reasoning/cost/timing not in the GenAI usage set).
    "teros.usage.total_tokens": call.totalTokens,
    "teros.usage.cache_read_tokens": call.cacheReadTokens,
    "teros.usage.cache_write_tokens": call.cacheWriteTokens,
    "teros.usage.reasoning_tokens": call.reasoningTokens,
    "teros.usage.cost_usd": call.costTotal,
    "teros.usage.step": call.step ?? 0,
  }
  // Per-call upstream — distinct from the logical provider; the F3b ZDR guard
  // will read retention per call from exactly this.
  if (call.actualProvider) attributes["teros.usage.actual_provider"] = call.actualProvider
  if (call.latencyMs !== undefined) attributes["teros.usage.latency_ms"] = call.latencyMs
  if (call.ttftMs !== undefined) attributes["teros.usage.ttft_ms"] = call.ttftMs
  if (call.fallbackUsed !== undefined) attributes["teros.usage.fallback_used"] = call.fallbackUsed

  return {
    traceId: traceIdFor(s.rootSessionUsageId),
    spanId: spanIdFor(s.sessionUsageId, KIND_CHAT, idx),
    parentSpanId: spanIdFor(s.sessionUsageId, KIND_INVOKE_AGENT, 0),
    name: `${KIND_CHAT} ${call.modelId}`,
    kind: "INTERNAL",
    startEpochMs: start,
    endEpochMs: end,
    attributes,
  }
}

function buildToolSpan(s: TurnSessionTelemetry, tool: TurnToolTelemetry, idx: number): SpanDTO {
  const start = toEpochMs(tool.startedAt) ?? 0
  const end = start + (tool.durationMs ?? 0)

  const attributes: Record<string, SpanAttrValue> = {
    "gen_ai.operation.name": KIND_EXECUTE_TOOL,
    "gen_ai.tool.name": tool.toolName,
    "gen_ai.tool.call.id": tool.toolExecutionId,
    // MCA tools are extensions; native tools are plain functions.
    "gen_ai.tool.type": tool.mcaId ? "extension" : "function",
    "teros.usage.status": tool.status,
    "teros.usage.step_index": tool.stepIndex,
    "teros.usage.tool_call_index": tool.toolCallIndex,
  }
  if (tool.mcaId) attributes["teros.usage.mca_id"] = tool.mcaId
  if (tool.durationMs != null) attributes["teros.usage.duration_ms"] = tool.durationMs
  if (tool.inputSizeBytes !== undefined) attributes["teros.usage.input_size_bytes"] = tool.inputSizeBytes
  if (tool.outputSizeBytes !== undefined) {
    attributes["teros.usage.output_size_bytes"] = tool.outputSizeBytes
  }

  const span: SpanDTO = {
    traceId: traceIdFor(s.rootSessionUsageId),
    spanId: spanIdFor(s.sessionUsageId, KIND_EXECUTE_TOOL, idx),
    parentSpanId: spanIdFor(s.sessionUsageId, KIND_INVOKE_AGENT, 0),
    name: `${KIND_EXECUTE_TOOL} ${tool.toolName}`,
    kind: "INTERNAL",
    startEpochMs: start,
    endEpochMs: end,
    attributes,
  }
  if (tool.status === "error") {
    span.status = { code: "ERROR", ...(tool.errorMessage ? { message: tool.errorMessage } : {}) }
  }
  return span
}

/**
 * Build the flat span list for one turn. `rootAttrs` are extra attributes for
 * the root span only (e.g. deployment/service metadata the caller injects).
 *
 * The array is ordered root → chats → tools; ordering is presentational only,
 * Latitude rebuilds the tree from the ids.
 */
export function buildSpanTree(
  telemetry: AgentTurnTelemetry,
  rootAttrs: Record<string, SpanAttrValue>,
  opts: BuildSpanTreeOptions,
): SpanDTO[] {
  // Fail loud (ENGINEERING-PRINCIPLES §Fail Fast): flipping content on before
  // F3b would export message text with no ZDR guard. Refuse rather than leak.
  if (opts.includeContent) {
    throw new Error(
      "buildSpanTree: includeContent is not supported until F3b (text export is legally gated)",
    )
  }

  const s = telemetry.session
  const spans: SpanDTO[] = [buildRootSpan(s, rootAttrs)]
  telemetry.llmCalls.forEach((call, i) => spans.push(buildChatSpan(s, call, i)))
  telemetry.toolCalls.forEach((tool, j) => spans.push(buildToolSpan(s, tool, j)))
  return spans
}
