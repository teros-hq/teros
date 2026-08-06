#!/usr/bin/env node
/**
 * Deterministic monitoring seed for the E2E dashboard spec (A7.7 / TER-673).
 *
 * Inserts a FIXED, LLM-free set of usage sessions + hourly rollups (marked
 * `e2eSeed: true`) so `monitoring.spec.js` runs against reproducible numbers.
 * No randomness, no provider calls — the same run always yields the same KPIs.
 *
 * Usage:
 *   MONGODB_DATABASE=teros bun scripts/playwright-smoke/seed-monitoring-e2e.mjs
 *   MONGODB_DATABASE=teros bun scripts/playwright-smoke/seed-monitoring-e2e.mjs --clean
 */

import { MongoClient } from "mongodb"

const URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017"
const DB = process.env.MONGODB_DATABASE ?? "teros"
const CLEAN = process.argv.includes("--clean")

// A fixed hour well in the past so it is always a CLOSED rollup hour.
const HOUR = new Date("2026-06-01T10:00:00.000Z")
const GK = { userId: "user_e2e", agentId: "agent_e2e", provider: "teros", workspaceId: "work_e2e" }
const KEY = "fireworks::kimi-e2e"

function session(i, over) {
  const started = new Date(HOUR.getTime() + i * 60_000)
  return {
    sessionUsageId: `usess_e2e_${i}`,
    e2eSeed: true,
    parentSessionUsageId: null,
    triggerKind: "user_message",
    userId: GK.userId,
    agentId: GK.agentId,
    workspaceId: GK.workspaceId,
    channelId: "ch_e2e",
    provider: GK.provider,
    modelId: "kimi-e2e",
    actualProvider: "fireworks",
    actualModel: "kimi-e2e",
    startedAt: started,
    endedAt: new Date(started.getTime() + 5_000),
    durationMs: 5_000,
    durationSource: "monotonic",
    status: "completed",
    inputTokens: 1000,
    outputTokens: 200,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1200,
    costUsd: 0.01,
    latencyMs: 5000,
    ttftMs: 800,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: started,
    updatedAt: started,
    ...over,
  }
}

const SESSIONS = [
  session(0, {}),
  session(1, {}),
  session(2, {
    status: "errored",
    errorKind: "provider_error",
    outputTokens: 0,
    totalTokens: 1000,
  }),
]

// Element-wise histogram (14 bounds + overflow). Two 5s latency samples land in
// bucket 9 (2560,5120]; the errored turn also 5s → 3 samples. TTFT 800 → bucket 7.
const latencyBuckets = new Array(15).fill(0)
latencyBuckets[9] = 3
const ttftBuckets = new Array(15).fill(0)
ttftBuckets[7] = 3

const ROLLUP = {
  rollupId: "usro_e2e_0001",
  e2eSeed: true,
  hourBucket: HOUR,
  groupKey: GK,
  modelMix: {
    "kimi-e2e": {
      inputTokens: 3000,
      outputTokens: 400,
      cachedReadTokens: 0,
      totalTokens: 3400,
      costUsd: 0.03,
      sessionCount: 3,
    },
  },
  modelHealth: {
    [KEY]: {
      actualProvider: "fireworks",
      modelId: "kimi-e2e",
      requestCount: 3,
      latency: { buckets: latencyBuckets, count: 3, sum: 15000, max: 5000 },
      ttft: { buckets: ttftBuckets, count: 3, sum: 2400, max: 800 },
      statusCounts: { completed: 2, errored: 1 },
      errorCounts: { provider_error: 1 },
      finishReasons: {},
      emptyCount: 0,
      measuredCount: 3,
      stopReasonCount: 0,
      fallbackCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
    },
  },
  sessionCount: 3,
  completedCount: 2,
  erroredCount: 1,
  timedOutCount: 0,
  abortedCount: 0,
  inputTokens: 3000,
  outputTokens: 400,
  cachedReadTokens: 0,
  totalTokens: 3400,
  costUsd: 0.03,
  agentActiveMs: 15000,
  userActiveMs: 15000,
  createdAt: HOUR,
}

const client = new MongoClient(URI)
await client.connect()
const db = client.db(DB)
try {
  if (CLEAN) {
    const s = await db.collection("agent_usage_sessions").deleteMany({ e2eSeed: true })
    const r = await db.collection("agent_usage_rollups_hourly").deleteMany({ e2eSeed: true })
    console.log(`🧹 removed ${s.deletedCount} sessions + ${r.deletedCount} rollups`)
  } else {
    await db.collection("agent_usage_sessions").deleteMany({ e2eSeed: true })
    await db.collection("agent_usage_rollups_hourly").deleteMany({ e2eSeed: true })
    await db.collection("agent_usage_sessions").insertMany(SESSIONS)
    await db.collection("agent_usage_rollups_hourly").insertOne(ROLLUP)
    console.log(
      `✅ seeded ${SESSIONS.length} sessions + 1 rollup at ${HOUR.toISOString()} (e2eSeed:true)`,
    )
  }
} finally {
  await client.close()
}
