/**
 * F4 — LIVE bridge smoke (Teros → self-hosted Latitude).
 *
 * Drives the REAL F3a exporter + C0 score client against a LIVE local Latitude,
 * proving what mutation-verified fakes cannot: (a) Latitude accepts F3a's exact
 * OTLP payload; (b) the REST /scores endpoint accepts C0's exact categorical
 * score; (c) the score's `traceIdFor(root)` matches the ingested trace (the
 * trace-not-found flush race — this smoke is how we found that Latitude answers
 * it with 404, not 400); (d) failing scores cluster into a signal.
 *
 * Prereqs: a local Latitude with the seed project + token. Run from
 * `packages/backend`:
 *   LATITUDE_EXPORT_URL=http://localhost:3002/v1/traces \
 *   LATITUDE_API_URL=http://localhost:3011 \
 *   LATITUDE_EXPORT_TOKEN=lat_seed_default_api_key_token \
 *   LATITUDE_EXPORT_PROJECT=default-project \
 *   node_modules/.bin/tsx scripts/latitude-bridge-live-smoke.mts
 *
 * Then check Latitude: ClickHouse `spans` for the traces, Postgres `scores` +
 * `signals` for the categorical scores and the clustered signal.
 */
import { buildSpanTree, traceIdFor } from "../src/services/otel-span-builder.js"
import { createLatitudeExporter } from "../src/services/otel-latitude-exporter.js"
import {
  createLatitudeScoreClient,
  type ScoreReason,
  type ScoreSubmitPayload,
  type ScoreSubmitResult,
} from "../src/services/latitude-score-emitter.js"
import type { AgentTurnTelemetry } from "../src/services/session-trace-assembler.js"

const EXPORT_URL = process.env.LATITUDE_EXPORT_URL || "http://localhost:3002/v1/traces"
const API_URL = process.env.LATITUDE_API_URL || "http://localhost:3011"
const TOKEN = process.env.LATITUDE_EXPORT_TOKEN || "lat_seed_default_api_key_token"
const PROJECT = process.env.LATITUDE_EXPORT_PROJECT || "default-project"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A realistic turn telemetry with a unique root id and RECENT timestamps
 * (Latitude's ingest drops spans dated far in the past). */
function makeTurn(rootId: string, base = Date.now() - 10_000): AgentTurnTelemetry {
  return {
    session: {
      sessionUsageId: rootId,
      parentSessionUsageId: null,
      rootSessionUsageId: rootId,
      triggerKind: "user_message",
      userId: "user_smoke_f4",
      agentId: "agent_smoke_f4",
      workspaceId: "work_smoke_f4",
      channelId: "ch_smoke_f4",
      coreId: "smoke-agent",
      provider: "openai",
      actualProvider: "openai",
      modelId: "gpt-4o",
      actualModel: "gpt-4o",
      startedAt: new Date(base),
      endedAt: new Date(base + 4000),
      durationMs: 4000,
      status: "completed",
      llmCallCount: 1,
      toolCallCount: 1,
      costUsd: 0.013,
    },
    llmCalls: [
      {
        usageId: `${rootId}_usage0`,
        step: 0,
        provider: "openai",
        actualProvider: "openai",
        modelId: "gpt-4o",
        actualModel: "gpt-4o",
        promptTokens: 220,
        completionTokens: 65,
        totalTokens: 285,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costTotal: 0.013,
        latencyMs: 900,
        ttftMs: 260,
        finishReasons: ["tool_calls"],
        fallbackUsed: false,
        messageId: `${rootId}_msg0`,
        timestamp: new Date(base + 3800),
      },
    ],
    toolCalls: [
      {
        toolExecutionId: `${rootId}_tex0`,
        stepIndex: 0,
        toolCallIndex: 0,
        toolName: "search",
        mcaId: "mca.brave",
        status: "success",
        startedAt: new Date(base + 2000),
        durationMs: 480,
        inputSizeBytes: 30,
        outputSizeBytes: 420,
      },
    ],
  }
}

async function submitWithRetry(
  client: ReturnType<typeof createLatitudeScoreClient>,
  payload: ScoreSubmitPayload,
  label: string,
): Promise<ScoreSubmitResult> {
  const delays = [0, 3000, 5000, 8000]
  let last: ScoreSubmitResult = { kind: "error" }
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i])
    last = await client.submit(payload)
    console.log(`  [${label}] attempt ${i + 1}: ${JSON.stringify(last)}`)
    if (last.kind === "ok") return last
    if (last.kind === "error" && last.status !== 404) return last
  }
  return last
}

async function main() {
  console.log("=== F4 live bridge smoke ===")
  console.log(`ingest=${EXPORT_URL} api=${API_URL} project=${PROJECT}`)

  const exporter = createLatitudeExporter({
    url: EXPORT_URL,
    token: TOKEN,
    project: PROJECT,
    hooks: {
      onEnqueue: (n) => console.log(`  [exporter] enqueued ${n} spans`),
      onExportResult: (ok, n) => console.log(`  [exporter] export result ok=${ok} count=${n}`),
    },
  })
  const scoreClient = createLatitudeScoreClient({ apiBaseUrl: API_URL, token: TOKEN, project: PROJECT })

  const stamp = Date.now().toString(36)
  const turns = [
    { root: `usess_smoke_${stamp}_a`, reason: "tool_error" as ScoreReason },
    { root: `usess_smoke_${stamp}_b`, reason: "tool_error" as ScoreReason },
    { root: `usess_smoke_${stamp}_c`, reason: "thumbs_down" as ScoreReason },
  ]

  console.log("\n--- 1) export traces (F3a exporter → ingest) ---")
  for (const t of turns) {
    const spans = buildSpanTree(makeTurn(t.root), {}, { includeContent: false })
    exporter.export(spans)
    console.log(`  exported trace ${traceIdFor(t.root)} (root ${t.root}, ${spans.length} spans)`)
  }
  await exporter.forceFlush()

  console.log("\n--- 2) wait for ingest to settle (7s) ---")
  await sleep(7000)

  console.log("\n--- 3) submit categorical scores (C0 client → REST /scores) ---")
  const results: Record<string, ScoreSubmitResult> = {}
  for (const t of turns) {
    const payload: ScoreSubmitPayload = {
      value: 0,
      passed: false,
      feedback: t.reason,
      sourceId: `smoke-f4-${stamp}`,
      trace: { by: "id", id: traceIdFor(t.root) },
      metadata: { reason: t.reason, agentId: "agent_smoke_f4", provider: "openai" },
    }
    console.log(`  submitting ${t.reason} for trace ${traceIdFor(t.root)}`)
    results[t.root] = await submitWithRetry(scoreClient, payload, t.reason)
  }
  await exporter.shutdown()

  console.log("\n=== SUMMARY ===")
  for (const t of turns) console.log(`  ${t.root} (${t.reason}): ${JSON.stringify(results[t.root])}`)
  const okCount = Object.values(results).filter((r) => r.kind === "ok").length
  console.log(`\nscores OK: ${okCount}/${turns.length}  ·  sourceId in Latitude: smoke-f4-${stamp}`)
  process.exit(okCount === turns.length ? 0 : 1)
}

main().catch((e) => {
  console.error("FATAL", e)
  process.exit(2)
})
