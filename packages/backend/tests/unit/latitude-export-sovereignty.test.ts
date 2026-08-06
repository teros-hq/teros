/**
 * F3a — soberanía (Principio 2 + 3): el PRODUCTO no depende de Latitude.
 *
 * Two lint-as-test guards + one behavioral guard:
 *   1. No source file imports the proprietary `@latitude-data/*` client — the
 *      export leaves via standard OTLP only (portability = exit plan).
 *   2. The isolated OTLP transport (`otel-latitude-exporter`, the only module
 *      that touches the wire) is imported ONLY from the export orchestrator and
 *      the wiring — never from a hot-path / product module. Its allowlist is
 *      explicit; a new importer fails this test on purpose.
 *   3. `exportTurn` never throws and never rejects, even when the transport is
 *      dead — "Latitude unreachable → product identical".
 *
 * These are cheap and catch an entire class of regression: the day someone wires
 * the export into the turn path (re-coupling), or re-adds the vendor SDK.
 */

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { FEATURE_FLAG_REGISTRY } from "@teros/shared"
import { LatitudeScoreEmitter } from "../../src/services/latitude-score-emitter"
import { SessionTraceExporter } from "../../src/services/session-trace-export-service"
import type { AgentUsageSession } from "../../src/types/database"

const SRC = join(import.meta.dir, "../../src")

function allTsFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[]).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
  )
}
function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8")
}

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

describe("F3a sovereignty (lint-as-test)", () => {
  it("no source file imports the proprietary @latitude-data client", () => {
    const offenders = allTsFiles().filter((f) => /@latitude-data\//.test(read(f)))
    // The vendor SDK was retired in F3a — the export is standard OTLP now.
    expect(offenders).toEqual([])
  })

  it("the isolated OTLP transport is imported only from the export service + wiring", () => {
    const ALLOW = new Set([
      "services/session-trace-export-service.ts", // the orchestrator (type import)
      "bootstrap/container-setup.ts", // the wiring (createLatitudeExporter)
    ])
    const importers = allTsFiles().filter(
      (f) =>
        !ALLOW.has(f) &&
        !f.startsWith("services/otel-latitude-exporter") &&
        /from\s+["'][^"']*otel-latitude-exporter/.test(read(f)),
    )
    // A hot-path / product module importing the transport = re-coupling. If this
    // fails, either move the import behind the export service or extend ALLOW
    // with a documented reason.
    expect(importers).toEqual([])
  })

  it("the score emitter (F4·C0) is imported only from its seams + wiring", () => {
    // Seams: the applier + the feedback handler receive it by DI (type import);
    // the wiring constructs it. NO routing / failover / billing / auth / gating
    // module may import it — a score is telemetry, never a product decision.
    const ALLOW = new Set([
      "bootstrap/container-setup.ts", // wiring (createLatitudeScoreClient + LatitudeScoreEmitter)
      "container/tokens.ts", // DI token (type)
      "services/agent-usage-event-applier.ts", // tool-error seam (type)
      "services/latitude-score-metrics.ts", // shares the ScoreReason type
      "handlers/domains/feedback/index.ts", // 👎 seam (type)
      "handlers/websocket-handler.ts", // passes it into the feedback domain (type)
    ])
    const importers = allTsFiles().filter(
      (f) =>
        !ALLOW.has(f) &&
        !f.startsWith("services/latitude-score-emitter") &&
        /from\s+["'][^"']*latitude-score-emitter/.test(read(f)),
    )
    expect(importers).toEqual([])
  })

  it("the signal webhook + index (F4·C1) are imported only from their seams + wiring", () => {
    // The return path: the webhook handler and its Mongo projection may only be
    // constructed by the wiring and read by the Session Trace badge — never from
    // routing / failover / billing / auth / gating. A badge is a disposable
    // decoration, never a product decision.
    const ALLOW = new Set([
      "bootstrap/container-setup.ts", // constructs the index
      "bootstrap/server-bootstrap.ts", // constructs the webhook handler + ensureIndexes
      "bootstrap/http-server.ts", // dispatches the route (type)
      "container/tokens.ts", // DI token (type)
      "handlers/latitude-webhook-handler.ts", // handler reads the index (badge type)
      "handlers/domains/admin-api/agent-usage.ts", // Session Trace badge lookup
    ])
    const importers = allTsFiles().filter(
      (f) =>
        !ALLOW.has(f) &&
        !f.startsWith("services/latitude-signal-index") &&
        !f.startsWith("handlers/latitude-webhook-handler") &&
        /from\s+["'][^"']*(latitude-signal-index|latitude-webhook-handler)/.test(read(f)),
    )
    expect(importers).toEqual([])
  })

  it("the signals read client (F4·C2) is imported only from its seam + wiring", () => {
    // The dashboard read path: the one module that talks to the Latitude signals
    // REST wire may only be constructed by the wiring and called from its admin-api
    // seam — never from routing / failover / billing / auth / gating. Reading a
    // clustered signal is a disposable, best-effort decoration, never a product
    // decision. A new importer fails this on purpose (extend ALLOW with a reason).
    const ALLOW = new Set([
      "bootstrap/container-setup.ts", // constructs the client (createLatitudeReadClient)
      "container/tokens.ts", // DI token (type)
      "handlers/domains/admin-api/index.ts", // threads it into the domain deps (type)
      "handlers/domains/admin-api/latitude-signals.ts", // the seam (handler)
      "handlers/websocket-handler.ts", // passes it into the admin-api domain (type)
    ])
    const importers = allTsFiles().filter(
      (f) =>
        !ALLOW.has(f) &&
        !f.startsWith("services/latitude-read-client") &&
        /from\s+["'][^"']*latitude-read-client/.test(read(f)),
    )
    expect(importers).toEqual([])
  })

  it("the score emitter pins the trace via traceIdFor, never a hand-rolled hash", () => {
    const src = read("services/latitude-score-emitter.ts")
    // Anti meaning-drift (adversarial finding M-1): the score MUST match the
    // trace the span-builder stamped, i.e. reuse traceIdFor(rootSessionUsageId).
    expect(/import\s*\{[^}]*\btraceIdFor\b[^}]*\}\s*from\s*["'][^"']*otel-span-builder/.test(src)).toBe(
      true,
    )
    expect(src.includes("traceIdFor(")).toBe(true)
    // It must NOT re-derive the trace id itself (that would silently drift from
    // the exporter's derivation the day one side changes).
    expect(src.includes("createHash(")).toBe(false)
    expect(/trace\|\$\{/.test(src)).toBe(false)
  })

  it("the Session Trace badge lookup (F4·C1) pins the trace via traceIdFor", () => {
    const src = read("handlers/domains/admin-api/agent-usage.ts")
    // Anti meaning-drift (mirror of the emitter guard): the badge join key MUST be
    // the SAME 32-hex trace id the exporter stamped and Latitude echoed back, i.e.
    // reuse traceIdFor(rootSessionUsageId) — not a hand-rolled hash that could
    // silently drift the day one side changes.
    expect(
      /import\s*\{[^}]*\btraceIdFor\b[^}]*\}\s*from\s*["'][^"']*otel-span-builder/.test(src),
    ).toBe(true)
    expect(src.includes("traceIdFor(")).toBe(true)
    expect(src.includes("createHash(")).toBe(false)
    expect(/trace\|\$\{/.test(src)).toBe(false)
  })

  it("the C3 prompt-regression gate decides from LOCAL grading only — no Latitude in the runner", () => {
    // Soberanía: the gate verdict (`regressed`) must be derivable with Latitude
    // down. The runner core + grader + goldens + session store therefore import
    // NO Latitude client — the optional scoreboard is an injected sink wired only
    // in the CLI (`scripts/`, outside src/). If any of these imported the score
    // emitter, the decision could read Latitude → fail on purpose.
    const gateCore = [
      "eval/prompt-regression.ts",
      "eval/grade.ts",
      "eval/goldens.ts",
      "eval/eval-session-store.ts",
    ]
    for (const f of gateCore) {
      const src = read(f)
      expect(/from\s+["'][^"']*latitude/i.test(src)).toBe(false)
    }
  })

  it("both Latitude observability flags are declared in the registry (so they can turn on)", () => {
    // A flag used by createCachedGlobalFlag but absent from the registry throws
    // in resolve(), gets swallowed by onError, and stays permanently false — the
    // "declared but inert" failure class. Assert the keys exist + default off.
    for (const key of ["observability.latitude-export", "observability.latitude-scores"]) {
      const def = FEATURE_FLAG_REGISTRY[key]
      expect(def).toBeDefined()
      expect(def?.defaultValue).toBe(false)
    }
  })
})

describe("F3a sovereignty: Latitude unreachable → product identical", () => {
  const session = {
    sessionUsageId: "usess_dead",
    parentSessionUsageId: null,
    rootSessionUsageId: "usess_dead",
    triggerKind: "user_message",
    userId: "user_1",
    agentId: "agent_1",
    workspaceId: "work_1",
    channelId: "ch_1",
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
  } as unknown as AgentUsageSession

  const fakeDb = {
    collection: (name: string) => ({
      findOne: async () => (name === "agent_usage_sessions" ? session : null),
      find: () => ({ toArray: async () => [] }),
    }),
  } as any

  it("exportTurn does not throw and swallows a dead transport", async () => {
    let unhandled = false
    const onUnhandled = () => {
      unhandled = true
    }
    process.on("unhandledRejection", onUnhandled)

    const deadTransport = {
      export: () => {
        throw new Error("latitude ingest unreachable")
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
    let buildErrors = 0
    const exporter = new SessionTraceExporter({
      db: fakeDb,
      transport: deadTransport,
      isEnabled: () => true,
      log: stubLogger,
      metrics: {
        recordEnqueued: () => {},
        recordExportResult: () => {},
        recordBuildError: () => {
          buildErrors++
        },
        recordDropped: () => {},
        setInFlight: () => {},
      },
    })

    // The product-path call (the applier's trigger) must return synchronously
    // without throwing, no matter the transport state.
    expect(() => exporter.exportTurn("usess_dead")).not.toThrow()

    // Let the detached build+export settle.
    await new Promise((r) => setTimeout(r, 30))
    process.off("unhandledRejection", onUnhandled)

    expect(unhandled).toBe(false) // no leaked rejection reaches the process
    expect(buildErrors).toBe(1) // the failure was caught + counted, not propagated
  })

  it("exportTurn is a no-op when the flag is off", () => {
    let touched = false
    const transport = {
      export: () => {
        touched = true
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    }
    const exporter = new SessionTraceExporter({
      db: fakeDb,
      transport,
      isEnabled: () => false,
      log: stubLogger,
    })
    exporter.exportTurn("usess_dead")
    expect(touched).toBe(false)
  })
})

describe("F4·C0 score emitter: Latitude unreachable → product identical", () => {
  const session = {
    sessionUsageId: "usess_x",
    rootSessionUsageId: "usess_root",
    provider: "anthropic", // non-ZDR, so the ZDR gate does not short-circuit
    actualProvider: "anthropic",
    workspaceId: "work_1",
    agentId: "agent_1",
    toolErrorCount: 3,
  } as unknown as AgentUsageSession

  const fakeDb = {
    collection: (name: string) => ({
      findOne: async () =>
        name === "agent_usage_sessions"
          ? session
          : name === "llm_usage"
            ? { sessionUsageId: "usess_x" }
            : null,
    }),
  } as any

  const instantSleep = () => Promise.resolve()

  it("emit* return synchronously, never throw, and swallow a dead client", async () => {
    let unhandled = false
    const onUnhandled = () => {
      unhandled = true
    }
    process.on("unhandledRejection", onUnhandled)

    let dropped = 0
    const deadClient = {
      submit: async () => {
        throw new Error("latitude scores API unreachable")
      },
    }
    const emitter = new LatitudeScoreEmitter({
      db: fakeDb,
      client: deadClient,
      isEnabled: () => true,
      log: stubLogger,
      sleep: instantSleep,
      metrics: {
        recordEmitted: () => {},
        recordDelivered: () => {},
        recordDropped: () => {
          dropped++
        },
        recordTraceNotFoundRetry: () => {},
        setInFlight: () => {},
      },
    })

    // Both product-path calls must return synchronously without throwing.
    expect(() => emitter.emitSessionFailure({ sessionUsageId: "usess_x" })).not.toThrow()
    expect(() => emitter.emitMessageFeedback({ messageId: "msg_1", rating: "down" })).not.toThrow()

    await new Promise((r) => setTimeout(r, 30))
    process.off("unhandledRejection", onUnhandled)

    expect(unhandled).toBe(false) // no leaked rejection reaches the process
    expect(dropped).toBe(2) // both failures were caught + counted, not propagated
  })

  it("emit* are a no-op when the flag is off (no query, no submit)", async () => {
    let queried = false
    let submitted = false
    const spyingDb = {
      collection: () => ({
        findOne: async () => {
          queried = true
          return session
        },
      }),
    } as any
    const emitter = new LatitudeScoreEmitter({
      db: spyingDb,
      client: {
        submit: async () => {
          submitted = true
          return { kind: "ok" as const }
        },
      },
      isEnabled: () => false,
      log: stubLogger,
      sleep: instantSleep,
    })
    emitter.emitSessionFailure({ sessionUsageId: "usess_x" })
    emitter.emitMessageFeedback({ messageId: "msg_1", rating: "down" })
    await new Promise((r) => setTimeout(r, 10))
    expect(queried).toBe(false)
    expect(submitted).toBe(false)
  })
})
