/**
 * Demo monitoring data seeder (LOCAL DEV ONLY — reversible).
 *
 * Populates `agent_usage_sessions` + `agent_usage_rollups_hourly` +
 * `tool_executions` for the last 24h across ~8 provider×model pairs and 3 demo
 * users, so the whole Monitoring suite (incl. the Agent Activity Quota / Cache /
 * Tokens / Tools / Health tabs) renders as full as the design mock. Reuses the
 * REAL `buildModelHealthFromSessions` so the `modelHealth` histogram blocks are
 * faithful (percentiles/heatmap/tables work).
 *
 * Cache tokens follow each provider's real capability: `active` (anthropic)
 * reads + writes cache, `auto` (openai/google) reads only, `off` (meta/mistral)
 * neither — so the Cache panel's honest degradation ("not measured here") is
 * exercised alongside real hit ratios. tokenBreakdown is attached for the
 * providers that report it (all but meta/mistral) so the Tokens panel shows both
 * the composition bars AND the "no breakdown" gap note.
 *
 * NOTE: per-user agentHoursLimit comes from real subscriptions/plans (the
 * directory query reads them live); the demo users have none, so the Quota panel
 * falls back to the display default (100h). Seeding billing is out of scope here.
 *
 * Every doc carries `demoSeed: true`; re-running wipes prior demo docs first, and
 * `--clean` removes them and exits. Never touches non-demo rows.
 *
 *   MONGODB_DATABASE=teros ./node_modules/.bin/tsx scripts/demo-monitoring-seed.mts           # seed
 *   MONGODB_DATABASE=teros ./node_modules/.bin/tsx scripts/demo-monitoring-seed.mts --clean   # remove demo docs
 */
import { MongoClient } from "mongodb"
import { buildModelHealthFromSessions } from "../packages/backend/src/services/model-health-aggregator.js"

const URI = process.env.MONGO_URI || "mongodb://localhost:27017"
const DB = process.env.MONGODB_DATABASE || "teros"
const CLEAN = process.argv.includes("--clean")

const WORKSPACE = "work_demo_monitoring"

type CacheKind = "active" | "auto" | "off"
type Model = {
  agent: string
  channel: string
  user: string // demo user id — spreads activity across the Quota "By user" table
  provider: string // logical
  actualProvider: string
  modelId: string
  actualModel: string
  cache: CacheKind
  p50: number // latency ms median
  spread: number // multiplicative tail
  ttft: number
  errRate: number
  satRate: number
  baseVol: number // sessions per hour at peak
  breakdown: boolean // does this model report a per-category token breakdown?
}

const U = { alice: "user_demo_alice", bob: "user_demo_bob", cara: "user_demo_cara" }

// Mirrors the design's model mix for visual parity.
const MODELS: Model[] = [
  { agent: "Atlas", channel: "ops-alerts", user: U.alice, provider: "anthropic", actualProvider: "anthropic", modelId: "claude-sonnet-4.5", actualModel: "claude-sonnet-4.5", cache: "active", p50: 640, spread: 3.2, ttft: 320, errRate: 0.004, satRate: 0.02, baseVol: 40, breakdown: true },
  { agent: "Scout", channel: "web-crawl", user: U.bob, provider: "openai", actualProvider: "openai", modelId: "gpt-4o", actualModel: "gpt-4o", cache: "auto", p50: 720, spread: 3.6, ttft: 410, errRate: 0.009, satRate: 0.03, baseVol: 26, breakdown: true },
  { agent: "Sentry", channel: "cron", user: U.alice, provider: "anthropic", actualProvider: "anthropic", modelId: "claude-haiku-4", actualModel: "claude-haiku-4", cache: "active", p50: 240, spread: 3.8, ttft: 140, errRate: 0.003, satRate: 0.01, baseVol: 22, breakdown: true },
  { agent: "Ledger", channel: "finance", user: U.cara, provider: "anthropic", actualProvider: "anthropic", modelId: "claude-opus-4.1", actualModel: "claude-opus-4.1", cache: "active", p50: 1120, spread: 3.5, ttft: 540, errRate: 0.007, satRate: 0.04, baseVol: 14, breakdown: true },
  { agent: "Muse", channel: "content", user: U.bob, provider: "google", actualProvider: "google", modelId: "gemini-2.5-pro", actualModel: "gemini-2.5-pro", cache: "auto", p50: 880, spread: 3.5, ttft: 470, errRate: 0.012, satRate: 0.03, baseVol: 10, breakdown: true },
  { agent: "Atlas", channel: "ops-alerts", user: U.alice, provider: "openai", actualProvider: "openai", modelId: "o3", actualModel: "o3", cache: "auto", p50: 2450, spread: 3.4, ttft: 1300, errRate: 0.021, satRate: 0.88, baseVol: 7, breakdown: true },
  { agent: "Recon", channel: "web-crawl", user: U.cara, provider: "meta", actualProvider: "meta", modelId: "llama-3.3-70b", actualModel: "llama-3.3-70b", cache: "off", p50: 560, spread: 5.2, ttft: 380, errRate: 0.038, satRate: 0.05, baseVol: 5, breakdown: false },
  { agent: "Ledger", channel: "finance", user: U.cara, provider: "mistral", actualProvider: "mistral", modelId: "mistral-large", actualModel: "mistral-large", cache: "off", p50: 690, spread: 5.0, ttft: 420, errRate: 0.016, satRate: 0.04, baseVol: 3, breakdown: false },
]

const TOOL_POOL: { name: string; mcaId?: string }[] = [
  { name: "web-search", mcaId: "mca.brave" },
  { name: "read-file", mcaId: "mca.filesystem" },
  { name: "run-query", mcaId: "mca.postgres" },
  { name: "send-message", mcaId: "mca.slack" },
  { name: "http-request", mcaId: "mca.http" },
  { name: "create-issue", mcaId: "mca.linear" },
]

// Deterministic-ish PRNG so re-runs are stable (no Math.random import needed).
let _s = 987654321
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const jitter = (base: number, mult: number) => Math.round(base * (1 + (rnd() - 0.4) * mult))
const hourShape = (h: number) => 0.25 + 0.75 * Math.max(0, Math.sin(((h - 4) / 24) * Math.PI)) // low at night, peak midday

/** Split fresh input tokens into the 9 breakdown categories (+ output). */
function makeBreakdown(input: number, output: number, hasTools: boolean) {
  const system = Math.round(input * 0.18)
  const tools = Math.round(input * (hasTools ? 0.12 : 0.04))
  const examples = Math.round(input * 0.06)
  const memory = Math.round(input * 0.08)
  const summary = Math.round(input * 0.05)
  const toolCalls = hasTools ? Math.round(input * 0.05) : 0
  const toolResults = hasTools ? Math.round(input * 0.1) : 0
  const conversation = Math.max(0, input - (system + tools + examples + memory + summary + toolCalls + toolResults))
  return { system, tools, examples, memory, summary, conversation, toolCalls, toolResults, output }
}

function makeToolExecutions(session: any, count: number) {
  const out: any[] = []
  for (let k = 0; k < count; k++) {
    const t = TOOL_POOL[Math.floor(rnd() * TOOL_POOL.length)]
    const r = rnd()
    const status = r < 0.86 ? "success" : r < 0.92 ? "error" : r < 0.97 ? "permission_denied" : "aborted"
    const startedAt = new Date(session.startedAt.getTime() + k * 300 + Math.floor(rnd() * 200))
    const durationMs = status === "permission_denied" ? null : Math.max(8, jitter(240, 2.4))
    const endedAt = durationMs == null ? null : new Date(startedAt.getTime() + durationMs)
    out.push({
      toolExecutionId: `utex_demo_${session.startedAt.getTime()}_${session.agentId}_${k}_${Math.floor(rnd() * 1e6)}`,
      sessionUsageId: session.sessionUsageId,
      channelId: session.channelId,
      userId: session.userId,
      agentId: session.agentId,
      workspaceId: session.workspaceId,
      stepIndex: 1,
      toolCallIndex: k,
      toolName: t.name,
      mcaId: t.mcaId,
      startedAt,
      endedAt,
      durationMs,
      status,
      errorMessage: status === "error" ? "upstream 500" : undefined,
      inputSizeBytes: jitter(320, 1.8),
      outputSizeBytes: status === "success" ? jitter(2600, 2.2) : jitter(180, 1.5),
      schemaVersion: 1,
      demoSeed: true,
      createdAt: startedAt,
      updatedAt: endedAt ?? startedAt,
    })
  }
  return out
}

function makeSession(m: Model, startedAt: Date, i: number): { s: any; tools: any[] } {
  const r = rnd()
  let status: "completed" | "errored" | "timed_out" | "aborted" = "completed"
  let errorKind: string | undefined
  if (r < m.errRate) { status = "errored"; errorKind = rnd() < 0.5 ? "rate_limited" : "server_error" }
  else if (r < m.errRate + m.satRate * 0.02) { status = "errored"; errorKind = "overloaded" }
  else if (r < m.errRate + 0.01) status = "aborted"
  const latencyMs = Math.max(30, jitter(m.p50, m.spread))
  const ttftMs = Math.max(20, jitter(m.ttft, 1.4))
  const inputTokens = jitter(2400, 1.2)
  const outputTokens = jitter(520, 1.6)
  const durationMs = latencyMs + jitter(400, 1.0)
  const endedAt = new Date(startedAt.getTime() + durationMs)
  const toolCallCount = rnd() < 0.6 ? Math.floor(rnd() * 4) : 0

  // Cache tokens follow the provider's real capability (disjoint from inputTokens,
  // Anthropic convention → the panel's cacheRead/(input+cacheRead) ratio is real).
  let cachedReadTokens = 0
  let cachedWriteTokens = 0
  if (m.cache === "active") {
    cachedReadTokens = rnd() < 0.7 ? jitter(Math.round(inputTokens * 0.5), 0.6) : 0
    cachedWriteTokens = rnd() < 0.5 ? jitter(Math.round(inputTokens * 0.2), 0.8) : 0
  } else if (m.cache === "auto") {
    cachedReadTokens = rnd() < 0.55 ? jitter(Math.round(inputTokens * 0.38), 0.7) : 0
  }

  const s = {
    sessionUsageId: `usess_demo_${startedAt.getTime()}_${m.modelId}_${i}`,
    parentSessionUsageId: null,
    triggerKind: "user_message",
    userId: m.user,
    agentId: `agent_demo_${m.agent}`,
    workspaceId: WORKSPACE,
    channelId: `ch_demo_${m.channel}`,
    coreId: m.agent.toLowerCase(),
    provider: m.provider,
    modelId: m.modelId,
    actualModel: m.actualModel,
    actualProvider: m.actualProvider,
    startedAt,
    endedAt,
    durationMs,
    durationSource: "monotonic",
    status,
    errorKind,
    latencyMs,
    ttftMs,
    stopReason: status === "completed" ? (outputTokens > 1400 ? "max_tokens" : "end_turn") : "error",
    fallbackUsed: rnd() < (m.actualProvider === "meta" ? 0.06 : 0.01),
    inputTokens,
    outputTokens,
    cachedReadTokens,
    cachedWriteTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd: +(inputTokens * 3e-6 + outputTokens * 1.5e-5).toFixed(6),
    ...(m.breakdown ? { tokenBreakdown: makeBreakdown(inputTokens, outputTokens, toolCallCount > 0) } : {}),
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1 + (toolCallCount > 0 ? 1 : 0),
    toolCallCount,
    toolErrorCount: toolCallCount > 0 && rnd() < 0.05 ? 1 : 0,
    schemaVersion: 1,
    demoSeed: true,
    createdAt: startedAt,
    updatedAt: endedAt,
  }
  return { s, tools: toolCallCount > 0 ? makeToolExecutions(s, toolCallCount) : [] }
}

async function main() {
  const client = await MongoClient.connect(URI)
  const db = client.db(DB)
  const sessionsC = db.collection("agent_usage_sessions")
  const rollupsC = db.collection("agent_usage_rollups_hourly")
  const toolsC = db.collection("tool_executions")

  const wiped =
    (await sessionsC.deleteMany({ demoSeed: true })).deletedCount +
    (await rollupsC.deleteMany({ demoSeed: true })).deletedCount +
    (await toolsC.deleteMany({ demoSeed: true })).deletedCount
  console.log(`removed ${wiped} prior demo docs`)
  if (CLEAN) { await client.close(); console.log("clean done"); return }

  const now = new Date()
  const startHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()))
  const allSessions: any[] = []
  const allTools: any[] = []
  const rollups: any[] = []

  for (let hBack = 23; hBack >= 0; hBack--) {
    const hourBucket = new Date(startHour.getTime() - hBack * 3_600_000)
    const shape = hourShape(hourBucket.getUTCHours())
    // group by (agent×provider) to mimic real rollup groupKeys
    const byGroup = new Map<string, any[]>()
    for (const m of MODELS) {
      const vol = Math.max(0, Math.round(m.baseVol * shape * (0.7 + rnd() * 0.6)))
      for (let i = 0; i < vol; i++) {
        const startedAt = new Date(hourBucket.getTime() + Math.floor(rnd() * 3_600_000))
        const { s, tools } = makeSession(m, startedAt, i)
        allSessions.push(s)
        allTools.push(...tools)
        const gk = `${s.agentId}|${s.provider}`
        if (!byGroup.has(gk)) byGroup.set(gk, [])
        byGroup.get(gk)!.push(s)
      }
    }
    for (const [gk, sess] of byGroup) {
      const [agentId, provider] = gk.split("|")
      const modelHealth = buildModelHealthFromSessions(sess as any)
      const modelMix: Record<string, any> = {}
      let inputTokens = 0, outputTokens = 0, totalTokens = 0, costUsd = 0, agentActiveMs = 0
      let cachedReadTokens = 0, cachedWriteTokens = 0
      const counts = { completedCount: 0, erroredCount: 0, abortedCount: 0, timedOutCount: 0 }
      for (const s of sess) {
        inputTokens += s.inputTokens; outputTokens += s.outputTokens; totalTokens += s.totalTokens
        costUsd += s.costUsd; agentActiveMs += s.durationMs
        cachedReadTokens += s.cachedReadTokens; cachedWriteTokens += s.cachedWriteTokens
        counts[`${s.status}Count` as keyof typeof counts]++
        const mk = s.actualModel
        const mm = (modelMix[mk] ??= { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, totalTokens: 0, costUsd: 0, sessionCount: 0 })
        mm.inputTokens += s.inputTokens; mm.outputTokens += s.outputTokens; mm.totalTokens += s.totalTokens
        mm.cachedReadTokens += s.cachedReadTokens; mm.costUsd += s.costUsd; mm.sessionCount++
      }
      rollups.push({
        groupKey: { userId: sess[0].userId, agentId, provider, workspaceId: WORKSPACE },
        hourBucket,
        ...counts,
        agentActiveMs,
        cachedReadTokens,
        cachedWriteTokens,
        computedAt: new Date(),
        costUsd: +costUsd.toFixed(6),
        createdAt: new Date(),
        inputTokens,
        jobRunId: "usro_demo",
        modelMix,
        modelHealth,
        outputTokens,
        rollupId: `usro_demo_${hourBucket.getTime()}_${agentId}_${provider}`,
        schemaVersion: 1,
        sessionCount: sess.length,
        totalTokens,
        demoSeed: true,
      })
    }
  }

  if (allSessions.length) await sessionsC.insertMany(allSessions)
  if (rollups.length) await rollupsC.insertMany(rollups)
  if (allTools.length) await toolsC.insertMany(allTools)
  console.log(
    `inserted ${allSessions.length} sessions + ${rollups.length} hourly rollups + ${allTools.length} tool executions across 24h (${MODELS.length} models, 3 users)`,
  )
  await client.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
