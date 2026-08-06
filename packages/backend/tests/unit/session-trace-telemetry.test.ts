/**
 * Unit tests for the F3a telemetry contract (`assembleTurnTelemetry`).
 * Mutation-verified: pins per-call cache tokens (M-I), the root fallback, the
 * finish_reasons derivation and chronological ordering.
 */

import { describe, expect, it } from "bun:test"
import { assembleTurnTelemetry } from "../../src/services/session-trace-assembler"
import type { AgentUsageSession, LLMUsage, ToolExecution } from "../../src/types/database"

function sessionDoc(o: Partial<AgentUsageSession> = {}): AgentUsageSession {
  return {
    sessionUsageId: "usess_A",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_A",
    triggerKind: "user_message",
    userId: "u",
    agentId: "a",
    workspaceId: "w",
    channelId: "ch",
    provider: "teros",
    modelId: "kimi",
    startedAt: new Date(0),
    endedAt: new Date(1000),
    durationMs: 1000,
    status: "completed",
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costUsd: 0.01,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...o,
  } as AgentUsageSession
}

function llmUsage(o: Partial<LLMUsage> = {}): LLMUsage {
  return {
    usageId: "usage_1",
    sessionUsageId: "usess_A",
    timestamp: new Date(1000),
    userId: "u",
    agentId: "a",
    coreId: "c",
    channelId: "ch",
    messageId: "m",
    step: 0,
    provider: "openai",
    modelId: "gpt",
    modelString: "gpt-4",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    costInput: 0,
    costOutput: 0,
    costTotal: 0.02,
    currency: "USD",
    ...o,
  } as unknown as LLMUsage
}

function toolExec(o: Partial<ToolExecution> = {}): ToolExecution {
  return {
    toolExecutionId: "tex_1",
    sessionUsageId: "usess_A",
    channelId: "ch",
    userId: "u",
    agentId: "a",
    workspaceId: "w",
    stepIndex: 0,
    toolCallIndex: 0,
    toolName: "search",
    startedAt: new Date(500),
    endedAt: new Date(900),
    durationMs: 400,
    durationSource: "monotonic",
    status: "success",
    schemaVersion: 1,
    createdAt: new Date(0),
    ...o,
  } as unknown as ToolExecution
}

describe("assembleTurnTelemetry — per-call cache tokens (M-I)", () => {
  it("carries per-call cache tokens; defaults absent to 0", () => {
    const t = assembleTurnTelemetry({
      session: sessionDoc(),
      llmUsages: [
        llmUsage({ usageId: "u1", cacheReadTokens: 12, cacheWriteTokens: 3 }),
        llmUsage({ usageId: "u2", timestamp: new Date(2000) }), // no cache fields
      ],
      toolExecutions: [],
    })
    expect(t.llmCalls[0].cacheReadTokens).toBe(12)
    expect(t.llmCalls[0].cacheWriteTokens).toBe(3)
    expect(t.llmCalls[1].cacheReadTokens).toBe(0)
    expect(t.llmCalls[1].cacheWriteTokens).toBe(0)
  })

  it("preserves per-call provider + actualProvider (guard F3b, C2)", () => {
    const t = assembleTurnTelemetry({
      session: sessionDoc(),
      llmUsages: [llmUsage({ provider: "openai-compatible", actualProvider: "together" })],
      toolExecutions: [],
    })
    expect(t.llmCalls[0].provider).toBe("openai-compatible")
    expect(t.llmCalls[0].actualProvider).toBe("together")
  })
})

describe("assembleTurnTelemetry — root fallback + finish_reasons", () => {
  it("uses the denormalized rootSessionUsageId when present", () => {
    const t = assembleTurnTelemetry({
      session: sessionDoc({ sessionUsageId: "usess_B", rootSessionUsageId: "usess_ROOT" }),
      llmUsages: [],
      toolExecutions: [],
    })
    expect(t.session.rootSessionUsageId).toBe("usess_ROOT")
  })

  it("falls back to sessionUsageId when the root is undefined (legacy row)", () => {
    const s = sessionDoc({ sessionUsageId: "usess_B" })
    delete (s as { rootSessionUsageId?: string }).rootSessionUsageId
    const t = assembleTurnTelemetry({ session: s, llmUsages: [], toolExecutions: [] })
    expect(t.session.rootSessionUsageId).toBe("usess_B")
  })

  it("derives finish_reasons array from the singular stopReason", () => {
    const withStop = assembleTurnTelemetry({
      session: sessionDoc(),
      llmUsages: [llmUsage({ stopReason: "length" } as Partial<LLMUsage>)],
      toolExecutions: [],
    })
    expect(withStop.llmCalls[0].finishReasons).toEqual(["length"])
    const without = assembleTurnTelemetry({
      session: sessionDoc(),
      llmUsages: [llmUsage()],
      toolExecutions: [],
    })
    expect(without.llmCalls[0].finishReasons).toEqual([])
  })
})

describe("assembleTurnTelemetry — chronological ordering", () => {
  it("sorts llm calls and tools by time", () => {
    const t = assembleTurnTelemetry({
      session: sessionDoc(),
      llmUsages: [
        llmUsage({ usageId: "late", timestamp: new Date(3000), step: 1 }),
        llmUsage({ usageId: "early", timestamp: new Date(1000), step: 0 }),
      ],
      toolExecutions: [
        toolExec({ toolExecutionId: "t_late", startedAt: new Date(2500), stepIndex: 1 }),
        toolExec({ toolExecutionId: "t_early", startedAt: new Date(500), stepIndex: 0 }),
      ],
    })
    expect(t.llmCalls.map((c) => c.usageId)).toEqual(["early", "late"])
    expect(t.toolCalls.map((c) => c.toolExecutionId)).toEqual(["t_early", "t_late"])
  })
})
