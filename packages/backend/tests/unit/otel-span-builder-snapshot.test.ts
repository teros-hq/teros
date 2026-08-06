/**
 * F3a — emitter snapshot (pieza 10, part 1: version protection).
 *
 * Anchors the EXACT SpanDTO wire shape a canonical turn produces. A snapshot
 * pinned to `AgentTurnTelemetry` catches any accidental change to the attribute
 * mapping (Teros-side churn) — the moment the emitter drifts, this fails loud
 * and forces a re-run of the parser smoke against the pinned Latitude digest
 *.
 *
 * Part 2 (the parser smoke: ingest a span into a real Latitude at the pinned
 * digest and assert it parses invoke_agent → chat/execute_tool) needs the
 * self-hosted stack and is Antonio's E2E — the runbook documents the digest pin
 * and the procedure. This snapshot protects the EMITTER; that smoke protects the
 * PARSER (adversarial finding M-H).
 */

import { describe, expect, it } from "bun:test"
import { buildSpanTree, spanIdFor, traceIdFor } from "../../src/services/otel-span-builder"
import type { AgentTurnTelemetry } from "../../src/services/session-trace-assembler"

const CANONICAL: AgentTurnTelemetry = {
  session: {
    sessionUsageId: "usess_canon",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_canon",
    triggerKind: "user_message",
    userId: "user_1",
    agentId: "agent_1",
    workspaceId: "work_1",
    channelId: "ch_1",
    coreId: "super-agent",
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "kimi-k2",
    actualModel: "accounts/fireworks/models/kimi-k2",
    startedAt: new Date(1000),
    endedAt: new Date(5000),
    durationMs: 4000,
    status: "completed",
    llmCallCount: 1,
    toolCallCount: 1,
    costUsd: 0.02,
  },
  llmCalls: [
    {
      usageId: "usage_1",
      step: 0,
      provider: "teros",
      actualProvider: "fireworks",
      modelId: "kimi-k2",
      actualModel: "accounts/fireworks/models/kimi-k2",
      promptTokens: 100,
      completionTokens: 40,
      totalTokens: 140,
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      reasoningTokens: 7,
      costTotal: 0.02,
      latencyMs: 800,
      ttftMs: 200,
      finishReasons: ["stop"],
      fallbackUsed: false,
      messageId: "msg_1",
      timestamp: new Date(4000),
    },
  ],
  toolCalls: [
    {
      toolExecutionId: "tex_1",
      stepIndex: 0,
      toolCallIndex: 0,
      toolName: "search",
      mcaId: "mca.brave",
      status: "success",
      startedAt: new Date(2000),
      durationMs: 500,
      inputSizeBytes: 20,
      outputSizeBytes: 300,
    },
  ],
}

describe("F3a emitter snapshot — canonical turn", () => {
  it("produces the exact invoke_agent → chat → execute_tool wire shape", () => {
    const spans = buildSpanTree(CANONICAL, {}, { includeContent: false })
    const traceId = traceIdFor("usess_canon")

    expect(spans).toEqual([
      {
        traceId,
        spanId: spanIdFor("usess_canon", "invoke_agent", 0),
        name: "invoke_agent",
        kind: "INTERNAL",
        startEpochMs: 1000,
        endEpochMs: 5000,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.provider.name": "teros",
          "gen_ai.agent.id": "agent_1",
          "gen_ai.conversation.id": "ch_1",
          "teros.usage.session_id": "usess_canon",
          "teros.usage.root_session_id": "usess_canon",
          "teros.usage.trigger_kind": "user_message",
          "teros.usage.workspace_id": "work_1",
          "teros.usage.user_id": "user_1",
          "teros.usage.status": "completed",
          "teros.usage.duration_ms": 4000,
          "teros.usage.cost_usd": 0.02,
          "teros.usage.llm_call_count": 1,
          "teros.usage.tool_call_count": 1,
          "teros.usage.actual_provider": "fireworks",
          "teros.usage.core_id": "super-agent",
        },
      },
      {
        traceId,
        spanId: spanIdFor("usess_canon", "chat", 0),
        parentSpanId: spanIdFor("usess_canon", "invoke_agent", 0),
        name: "chat kimi-k2",
        kind: "INTERNAL",
        startEpochMs: 3200,
        endEpochMs: 4000,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "teros",
          "gen_ai.request.model": "kimi-k2",
          "gen_ai.response.model": "accounts/fireworks/models/kimi-k2",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 40,
          "gen_ai.response.finish_reasons": ["stop"],
          "gen_ai.response.id": "usage_1",
          "teros.usage.total_tokens": 140,
          "teros.usage.cache_read_tokens": 12,
          "teros.usage.cache_write_tokens": 3,
          "teros.usage.reasoning_tokens": 7,
          "teros.usage.cost_usd": 0.02,
          "teros.usage.step": 0,
          "teros.usage.actual_provider": "fireworks",
          "teros.usage.latency_ms": 800,
          "teros.usage.ttft_ms": 200,
          "teros.usage.fallback_used": false,
        },
      },
      {
        traceId,
        spanId: spanIdFor("usess_canon", "execute_tool", 0),
        parentSpanId: spanIdFor("usess_canon", "invoke_agent", 0),
        name: "execute_tool search",
        kind: "INTERNAL",
        startEpochMs: 2000,
        endEpochMs: 2500,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "search",
          "gen_ai.tool.call.id": "tex_1",
          "gen_ai.tool.type": "extension",
          "teros.usage.status": "success",
          "teros.usage.step_index": 0,
          "teros.usage.tool_call_index": 0,
          "teros.usage.mca_id": "mca.brave",
          "teros.usage.duration_ms": 500,
          "teros.usage.input_size_bytes": 20,
          "teros.usage.output_size_bytes": 300,
        },
      },
    ])
  })
})
