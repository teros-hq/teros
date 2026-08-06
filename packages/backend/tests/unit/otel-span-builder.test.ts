/**
 * Unit tests for the F3a span-builder. Mutation-verified: each assertion pins
 * the exact payload, and the "usage only on chat" / IDs / parentesco tests fail
 * if the corresponding line is mutated (the whole point — they must MORDER).
 */

import { describe, expect, it } from "bun:test"
import {
  buildSpanTree,
  type SpanDTO,
  spanIdFor,
  traceIdFor,
} from "../../src/services/otel-span-builder"
import type {
  AgentTurnTelemetry,
  TurnLlmTelemetry,
  TurnSessionTelemetry,
  TurnToolTelemetry,
} from "../../src/services/session-trace-assembler"

function session(o: Partial<TurnSessionTelemetry> = {}): TurnSessionTelemetry {
  return {
    sessionUsageId: "usess_A",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_A",
    triggerKind: "user_message",
    userId: "user_1",
    agentId: "agent_1",
    workspaceId: "work_1",
    channelId: "ch_1",
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "kimi-k2",
    startedAt: new Date(1000),
    endedAt: new Date(5000),
    durationMs: 4000,
    status: "completed",
    llmCallCount: 1,
    toolCallCount: 1,
    costUsd: 0.02,
    ...o,
  }
}

function llm(o: Partial<TurnLlmTelemetry> = {}): TurnLlmTelemetry {
  return {
    usageId: "usage_1",
    step: 0,
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "kimi-k2",
    actualModel: "accounts/fireworks/models/kimi",
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
    ...o,
  }
}

function tool(o: Partial<TurnToolTelemetry> = {}): TurnToolTelemetry {
  return {
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
    ...o,
  }
}

function telemetry(o: Partial<AgentTurnTelemetry> = {}): AgentTurnTelemetry {
  return { session: session(), llmCalls: [llm()], toolCalls: [tool()], ...o }
}

const OPTS = { includeContent: false as const }

function byKind(spans: SpanDTO[], op: string): SpanDTO[] {
  return spans.filter((s) => s.attributes["gen_ai.operation.name"] === op)
}

describe("buildSpanTree — hierarchy", () => {
  it("emits exactly 1 invoke_agent + 1 chat per llm + 1 execute_tool per tool", () => {
    const spans = buildSpanTree(
      telemetry({ llmCalls: [llm(), llm({ usageId: "usage_2" })], toolCalls: [tool()] }),
      {},
      OPTS,
    )
    expect(spans).toHaveLength(4)
    expect(byKind(spans, "invoke_agent")).toHaveLength(1)
    expect(byKind(spans, "chat")).toHaveLength(2)
    expect(byKind(spans, "execute_tool")).toHaveLength(1)
  })

  it("names spans per semconv", () => {
    const spans = buildSpanTree(telemetry(), {}, OPTS)
    expect(byKind(spans, "invoke_agent")[0].name).toBe("invoke_agent")
    expect(byKind(spans, "chat")[0].name).toBe("chat kimi-k2")
    expect(byKind(spans, "execute_tool")[0].name).toBe("execute_tool search")
  })
})

describe("buildSpanTree — deterministic ids + parentesco", () => {
  it("shares one traceId (from the root) across every span", () => {
    const spans = buildSpanTree(telemetry(), {}, OPTS)
    const expected = traceIdFor("usess_A")
    expect(new Set(spans.map((s) => s.traceId))).toEqual(new Set([expected]))
    expect(expected).toHaveLength(32)
  })

  it("root invoke_agent has the deterministic span id and NO parent (top-level)", () => {
    const root = byKind(buildSpanTree(telemetry(), {}, OPTS), "invoke_agent")[0]
    expect(root.spanId).toBe(spanIdFor("usess_A", "invoke_agent", 0))
    expect(root.spanId).toHaveLength(16)
    expect(root.parentSpanId).toBeUndefined()
  })

  it("chat/tool spans hang off the session's invoke_agent", () => {
    const spans = buildSpanTree(telemetry(), {}, OPTS)
    const rootId = spanIdFor("usess_A", "invoke_agent", 0)
    expect(byKind(spans, "chat")[0].parentSpanId).toBe(rootId)
    expect(byKind(spans, "chat")[0].spanId).toBe(spanIdFor("usess_A", "chat", 0))
    expect(byKind(spans, "execute_tool")[0].parentSpanId).toBe(rootId)
    expect(byKind(spans, "execute_tool")[0].spanId).toBe(spanIdFor("usess_A", "execute_tool", 0))
  })

  it("a delegated child hangs off the PARENT's invoke_agent and shares the root traceId", () => {
    const child = telemetry({
      session: session({
        sessionUsageId: "usess_B",
        parentSessionUsageId: "usess_A",
        rootSessionUsageId: "usess_A",
      }),
    })
    const root = byKind(buildSpanTree(child, {}, OPTS), "invoke_agent")[0]
    // same trace as the parent tree
    expect(root.traceId).toBe(traceIdFor("usess_A"))
    // own span id, parent = the parent session's invoke_agent
    expect(root.spanId).toBe(spanIdFor("usess_B", "invoke_agent", 0))
    expect(root.parentSpanId).toBe(spanIdFor("usess_A", "invoke_agent", 0))
  })

  it("is deterministic — same input, identical ids", () => {
    const a = buildSpanTree(telemetry(), {}, OPTS)
    const b = buildSpanTree(telemetry(), {}, OPTS)
    expect(a.map((s) => [s.traceId, s.spanId, s.parentSpanId])).toEqual(
      b.map((s) => [s.traceId, s.spanId, s.parentSpanId]),
    )
  })
})

describe("buildSpanTree — usage lives ONLY on chat (anti double-count, M-G)", () => {
  it("the root carries NO gen_ai.usage.* tokens", () => {
    const root = byKind(buildSpanTree(telemetry(), {}, OPTS), "invoke_agent")[0]
    expect(root.attributes["gen_ai.usage.input_tokens"]).toBeUndefined()
    expect(root.attributes["gen_ai.usage.output_tokens"]).toBeUndefined()
  })

  it("the chat span carries the exact per-call usage", () => {
    const chat = byKind(buildSpanTree(telemetry(), {}, OPTS), "chat")[0]
    expect(chat.attributes["gen_ai.usage.input_tokens"]).toBe(100)
    expect(chat.attributes["gen_ai.usage.output_tokens"]).toBe(40)
    expect(chat.attributes["teros.usage.cache_read_tokens"]).toBe(12)
    expect(chat.attributes["teros.usage.cache_write_tokens"]).toBe(3)
  })
})

describe("buildSpanTree — semconv attribute mapping", () => {
  it("emits gen_ai.provider.name (not the deprecated gen_ai.system) on chat", () => {
    const chat = byKind(buildSpanTree(telemetry(), {}, OPTS), "chat")[0]
    // teros maps through the mapper's default → "teros"
    expect(chat.attributes["gen_ai.provider.name"]).toBe("teros")
    expect(chat.attributes["gen_ai.system"]).toBeUndefined()
    expect(chat.attributes["teros.usage.actual_provider"]).toBe("fireworks")
  })

  it("finish_reasons is an ARRAY", () => {
    const chat = byKind(buildSpanTree(telemetry(), {}, OPTS), "chat")[0]
    expect(chat.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"])
  })

  it("tool span carries gen_ai.tool.* and marks errors", () => {
    const spans = buildSpanTree(
      telemetry({ toolCalls: [tool({ status: "error", errorMessage: "boom" })] }),
      {},
      OPTS,
    )
    const t = byKind(spans, "execute_tool")[0]
    expect(t.attributes["gen_ai.tool.name"]).toBe("search")
    expect(t.attributes["gen_ai.tool.call.id"]).toBe("tex_1")
    expect(t.attributes["gen_ai.tool.type"]).toBe("extension") // mcaId present
    expect(t.status).toEqual({ code: "ERROR", message: "boom" })
  })

  it("timestamps map through toEpoch (ms) with latency-derived chat window", () => {
    const spans = buildSpanTree(telemetry(), {}, OPTS)
    const root = byKind(spans, "invoke_agent")[0]
    expect([root.startEpochMs, root.endEpochMs]).toEqual([1000, 5000])
    const chat = byKind(spans, "chat")[0]
    // end = timestamp(4000), start = end - latency(800)
    expect([chat.startEpochMs, chat.endEpochMs]).toEqual([3200, 4000])
    const t = byKind(spans, "execute_tool")[0]
    // start = startedAt(2000), end = start + duration(500)
    expect([t.startEpochMs, t.endEpochMs]).toEqual([2000, 2500])
  })
})

describe("buildSpanTree — fail-loud content guard (F3b seam)", () => {
  it("throws if includeContent is true (no ungated text export)", () => {
    expect(() => buildSpanTree(telemetry(), {}, { includeContent: true })).toThrow(/F3b/)
  })
})

describe("buildSpanTree — rootAttrs merge on the root only", () => {
  it("merges rootAttrs into invoke_agent, not into chat/tool", () => {
    const spans = buildSpanTree(telemetry(), { "deployment.environment": "prod" }, OPTS)
    expect(byKind(spans, "invoke_agent")[0].attributes["deployment.environment"]).toBe("prod")
    expect(byKind(spans, "chat")[0].attributes["deployment.environment"]).toBeUndefined()
  })
})
