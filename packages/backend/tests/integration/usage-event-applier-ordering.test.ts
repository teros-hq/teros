/**
 * Integration test: usage event application is at-least-once and
 * order-tolerant (MOD-7).
 *
 * The claim was inserted before applying and never released, so an event
 * whose apply failed was consumed without effect; a delta/ended arriving
 * before session.started (critical events bypass the queue) silently
 * matched nothing; session.running applied after session.ended left
 * startedAt null and the session was never billed. Real repositories, Mongo.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type Db, MongoClient } from "mongodb"
import { AgentUsageEventApplicationsRepository } from "../../src/services/agent-usage-event-applications-repository"
import { AgentUsageEventApplier } from "../../src/services/agent-usage-event-applier"
import { AgentUsageSessionRepository } from "../../src/services/agent-usage-session-repository"
import { ToolExecutionRepository } from "../../src/services/tool-execution-repository"

const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017"
const DB_NAME = `teros_test_applier_${Date.now()}`

let client: MongoClient
let db: Db
let available = false
let applier: AgentUsageEventApplier

const silentLog = { info() {}, warn() {}, error() {}, debug() {} } as never

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
    db = client.db(DB_NAME)
    available = true
  } catch {
    console.warn("[usage applier test] Mongo unreachable — skipping")
  }
})

afterAll(async () => {
  if (available) {
    await db.dropDatabase()
    await client.close()
  }
})

beforeEach(async () => {
  if (!available) return
  await db.dropDatabase()
  await db
    .collection("agent_usage_event_applications")
    .createIndex({ eventId: 1 }, { unique: true })
  applier = new AgentUsageEventApplier(
    new AgentUsageEventApplicationsRepository(db),
    new AgentUsageSessionRepository(db),
    new ToolExecutionRepository(db),
    silentLog,
  )
})

const T0 = new Date("2026-10-17T10:00:00Z")
const ev = (eventId: string, type: string, payload: Record<string, unknown>) =>
  ({ eventId, type, sessionUsageId: "usess_1", appliedAt: T0, payload }) as never

const started = ev("e_start", "session.started", {
  parentSessionUsageId: null,
  triggerKind: "user_message",
  userId: "user_1",
  agentId: "agent_1",
  workspaceId: "work_1",
  channelId: "ch_1",
  provider: "anthropic",
  modelId: "m",
})
const delta = ev("e_delta", "session.delta", {
  inputTokens: 100,
  outputTokens: 50,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0.01,
  llmCallCount: 1,
  toolCallCount: 0,
})
const running = ev("e_run", "session.running", { startedAt: T0 })
const ended = ev("e_end", "session.ended", {
  endedAt: new Date(T0.getTime() + 30_000),
  durationMs: 30_000,
  durationSource: "monotonic",
  status: "completed",
  parentSessionUsageId: null,
})

const session = () => db.collection("agent_usage_sessions").findOne({ sessionUsageId: "usess_1" })
const claimed = (eventId: string) =>
  db.collection("agent_usage_event_applications").countDocuments({ eventId })

describe("usage event applier ordering", () => {
  it("a delta before session.started fails, releases its claim, and applies on retry", async () => {
    if (!available) return
    await expect(applier.applyAll([delta])).rejects.toThrow("failed to apply")
    expect(await claimed("e_delta")).toBe(0)

    await applier.applyAll([started])
    await applier.applyAll([delta]) // the buffer's retry

    expect((await session())?.inputTokens).toBe(100)
    expect(await claimed("e_delta")).toBe(1)
  })

  it("an ended before session.started is retried instead of lost", async () => {
    if (!available) return
    await expect(applier.applyAll([ended])).rejects.toThrow()

    await applier.applyAll([started, running, ended])

    expect((await session())?.status).toBe("completed")
  })

  it("session.running after session.ended fills startedAt without reviving the session", async () => {
    if (!available) return
    await applier.applyAll([started, ended, running])

    const s = await session()
    expect(s?.status).toBe("completed")
    expect(s?.startedAt).toEqual(T0) // billable again
  })

  it("applyBatch (scripts) does not throw but also releases failed claims", async () => {
    if (!available) return
    expect(await applier.applyBatch([delta])).toBe(0)
    expect(await claimed("e_delta")).toBe(0)
  })

  it("a replayed event is applied once", async () => {
    if (!available) return
    await applier.applyAll([started, delta])
    await applier.applyAll([delta])

    expect((await session())?.inputTokens).toBe(100)
  })
})
