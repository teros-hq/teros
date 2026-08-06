/**
 * Unit tests for the F3a export orchestrator. Mutation-verified for the M-A
 * guard: a burst of session.ended must NOT fan out N× parallel Mongo queries —
 * the concurrency cap drops the excess (best-effort telemetry, never billing).
 */

import { describe, expect, it } from "bun:test"
import { SessionTraceExporter } from "../../src/services/session-trace-export-service"

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

const sessionRow = {
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
  inputTokens: 1,
  outputTokens: 1,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 2,
  costUsd: 0,
  descendantInputTokens: 0,
  descendantOutputTokens: 0,
  descendantCostUsd: 0,
  descendantSessionCount: 0,
  llmCallCount: 0,
  toolCallCount: 0,
  schemaVersion: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

function metricsSpy() {
  const c = { enqueued: 0, dropped: 0, results: 0, buildErrors: 0, maxInFlight: 0 }
  return {
    c,
    recordEnqueued: () => c.enqueued++,
    recordExportResult: () => c.results++,
    recordBuildError: () => c.buildErrors++,
    recordDropped: () => c.dropped++,
    setInFlight: (n: number) => {
      if (n > c.maxInFlight) c.maxInFlight = n
    },
  }
}

describe("SessionTraceExporter — concurrency cap (M-A)", () => {
  it("caps in-flight builds and drops the excess of a burst", async () => {
    // A findOne that never resolves until we release it — so we can observe the
    // in-flight cap under a synchronous burst.
    const gates: Array<() => void> = []
    let findOneCalls = 0
    const gatedDb = {
      collection: () => ({
        findOne: () => {
          findOneCalls++
          return new Promise((res) => gates.push(() => res(sessionRow)))
        },
        find: () => ({ toArray: async () => [] }),
      }),
    } as any

    const transport = { export: () => {}, forceFlush: async () => {}, shutdown: async () => {} }
    const m = metricsSpy()
    const exporter = new SessionTraceExporter({
      db: gatedDb,
      transport,
      isEnabled: () => true,
      log: stubLogger,
      maxConcurrency: 2,
      metrics: m,
    })

    // Burst of 5 finished turns.
    for (let i = 0; i < 5; i++) exporter.exportTurn("usess_A")

    // Only 2 builds started (reached findOne); 3 were dropped by the cap —
    // NOT 5 parallel queries.
    expect(findOneCalls).toBe(2)
    expect(m.c.dropped).toBe(3)
    expect(m.c.maxInFlight).toBe(2)

    // Release the gated builds so nothing leaks.
    gates.forEach((g) => g())
    await new Promise((r) => setTimeout(r, 20))
    expect(m.c.maxInFlight).toBe(2) // never exceeded the cap
  })

  it("frees a slot when a build completes, admitting the next turn", async () => {
    let findOneCalls = 0
    const fastDb = {
      collection: () => ({
        findOne: async () => {
          findOneCalls++
          return sessionRow
        },
        find: () => ({ toArray: async () => [] }),
      }),
    } as any
    const transport = { export: () => {}, forceFlush: async () => {}, shutdown: async () => {} }
    const exporter = new SessionTraceExporter({
      db: fastDb,
      transport,
      isEnabled: () => true,
      log: stubLogger,
      maxConcurrency: 1,
    })

    exporter.exportTurn("usess_A")
    await new Promise((r) => setTimeout(r, 10))
    exporter.exportTurn("usess_A")
    await new Promise((r) => setTimeout(r, 10))
    // Sequential admission: both ran because the first freed its slot.
    expect(findOneCalls).toBe(2)
  })
})

describe("SessionTraceExporter — happy path", () => {
  it("builds a span tree and hands it to the transport", async () => {
    const db = {
      collection: () => ({
        findOne: async () => sessionRow,
        find: () => ({ toArray: async () => [] }),
      }),
    } as any
    let exported: any[] | null = null
    const transport = {
      export: (spans: any[]) => {
        exported = spans
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
    const exporter = new SessionTraceExporter({
      db,
      transport,
      isEnabled: () => true,
      log: stubLogger,
    })
    exporter.exportTurn("usess_A")
    await new Promise((r) => setTimeout(r, 20))
    // A childless turn → exactly one invoke_agent span.
    expect(exported).not.toBeNull()
    expect(exported).toHaveLength(1)
    expect(exported?.[0].attributes["gen_ai.operation.name"]).toBe("invoke_agent")
  })
})
