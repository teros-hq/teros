/**
 * OpenTelemetry GenAI semantic conventions mapper.
 *
 * Converts our internal AgentUsageSession shape to OTel GenAI attributes.
 * Applied by query handlers when the request comes with `format='otel'`.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/ (v1.31+).
 *
 *
 */

import type { AgentUsageSession } from "../types/database.js"

/**
 * Map our `provider` value to the OTel `gen_ai.provider.name` (formerly
 * `gen_ai.system`, deprecated in semconv ≥1.37).
 *
 * OTel uses lowercased vendor names. For oauth-flavored entries we collapse
 * to the canonical vendor (the auth method is not part of the spec). The
 * well-known values do NOT enumerate the Teros upstreams (fireworks/together);
 * those travel in `teros.usage.actual_provider`. Exported for reuse by the F3a
 * span-builder. Accepts `string` so callers with a widened provider type don't
 * need a cast.
 */
export function mapProviderToOtel(provider: string): string {
  switch (provider) {
    case "anthropic":
    case "anthropic-oauth":
      return "anthropic"
    case "openai":
    case "openai-compatible":
      return "openai"
    case "openrouter":
      return "openrouter"
    case "google":
      return "google"
    case "groq":
      return "groq"
    case "zhipu":
    case "zhipu-coding":
      return "zhipu"
    case "ollama":
    case "ollama-cloud":
      return "ollama"
    default:
      return provider
  }
}

/**
 * Convert a session to OTel GenAI attributes.
 *
 * Returns a flat record (compatible with OTel attribute conventions). Teros-
 * specific extensions are prefixed `teros.usage.*` to avoid spec collision.
 */
export function toOtelGenAI(session: AgentUsageSession): Record<string, unknown> {
  return {
    // Spec attributes
    "gen_ai.operation.name": "agent.session",
    // `gen_ai.system` is deprecated for `gen_ai.provider.name` (semconv ≥1.37).
    // Emit BOTH — additive: the existing `format='otel'` consumer keeps its
    // field, new consumers (the F3a span export) read `provider.name`.
    "gen_ai.system": mapProviderToOtel(session.provider),
    "gen_ai.provider.name": mapProviderToOtel(session.provider),
    "gen_ai.request.model": session.modelId,
    "gen_ai.response.model": session.actualModel ?? session.modelId,
    "gen_ai.usage.input_tokens": session.inputTokens,
    "gen_ai.usage.output_tokens": session.outputTokens,
    "gen_ai.conversation.id": session.channelId,
    "gen_ai.agent.id": session.agentId,
    // Real upstream + degradation timing (TER-616/F1). `gen_ai.provider.name`
    // well-known does not enumerate fireworks/together, so the upstream lives in
    // the teros namespace; latency/TTFT mirror gen_ai.client.* duration metrics.
    "teros.usage.actual_provider": session.actualProvider,
    "teros.usage.latency_ms": session.latencyMs,
    "teros.usage.ttft_ms": session.ttftMs,
    // Teros custom (under reserved vendor namespace)
    "teros.usage.session_id": session.sessionUsageId,
    "teros.usage.parent_session_id": session.parentSessionUsageId,
    "teros.usage.trigger_kind": session.triggerKind,
    "teros.usage.workspace_id": session.workspaceId,
    "teros.usage.user_id": session.userId,
    "teros.usage.status": session.status,
    "teros.usage.error_kind": session.errorKind,
    "teros.usage.duration_ms": session.durationMs,
    "teros.usage.cost_usd": session.costUsd,
    "teros.usage.cache_read_tokens": session.cachedReadTokens,
    "teros.usage.cache_write_tokens": session.cachedWriteTokens,
    "teros.usage.reasoning_tokens": session.reasoningTokens,
    "teros.usage.llm_call_count": session.llmCallCount,
    "teros.usage.tool_call_count": session.toolCallCount,
    "teros.usage.descendant_input_tokens": session.descendantInputTokens,
    "teros.usage.descendant_output_tokens": session.descendantOutputTokens,
    "teros.usage.descendant_cost_usd": session.descendantCostUsd,
    "teros.usage.descendant_session_count": session.descendantSessionCount,
  }
}
