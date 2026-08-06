/**
 * Mongo-side helpers for the agent-usage sessions + scheduler recurring tasks
 * (TER-650). Specs run in the Playwright Node process, so we talk to Mongo
 * directly through the memoized client in db.ts.
 *
 * Used to assert the true `triggerKind` a session records: the phantom-session
 * incident revealed every non-user origin was mislabelled `user_message`, hiding
 * scheduler/autorun activity in the dashboard.
 */
import { getMongoDb } from "./db"

export interface UsageSessionLite {
  sessionUsageId: string
  channelId: string
  triggerKind: string
  status: string
  totalTokens: number
  errorKind?: string
  agentId: string
  userId: string
  /**
   * Execution-anchored start (TER-650/G1): null while the session is `queued`,
   * set when it flips to `running`. A completed turn must have it non-null.
   */
  startedAt: Date | null
  endedAt: Date | null
  durationMs: number | null
  /**
   * Degradation telemetry projected by the session.delta (TER-615). Null/absent
   * when the delta was dropped — the RC1 signature of TER-691 (a completed turn
   * with no latency/tokens because `session.ended` beat `session.delta`).
   */
  latencyMs?: number | null
  ttftMs?: number | null
  llmCallCount?: number
}

/**
 * Poll until a session for `channelId` reaches a terminal status matching
 * `predicate` (e.g. completed with tokens). Returns it, or null on timeout.
 * Used to assert the queued→running→completed lifecycle end-to-end (G1/G4).
 */
export async function waitForSessionWhere(
  channelId: string,
  predicate: (s: UsageSessionLite) => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<UsageSessionLite | null> {
  const { timeoutMs = 90_000, pollMs = 1500 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sessions = await getUsageSessionsByChannel(channelId)
    const match = sessions.find(predicate)
    if (match) return match
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/**
 * Poll agent_usage_sessions for a session of `agentId` (optionally a specific
 * triggerKind) created at/after `since`. The autorun channel is created by autoplay
 * (unknown id upfront), so G3 asserts by agentId, not channelId; the `since` cutoff
 * rejects a stale autorun session from an earlier test (workers:1 shares the agent).
 * Robust to the model: the session is written at session.started (triggerKind + userId
 * fixed) before the LLM answers.
 */
export async function waitForUsageSessionByAgent(
  agentId: string,
  opts: { triggerKind?: string; since?: Date; timeoutMs?: number; pollMs?: number } = {},
): Promise<UsageSessionLite | null> {
  const { triggerKind, since, timeoutMs = 60_000, pollMs = 1500 } = opts
  const db = await getMongoDb()
  const filter: Record<string, unknown> = { agentId }
  if (triggerKind) filter.triggerKind = triggerKind
  if (since) filter.createdAt = { $gte: since }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = (await db
      .collection("agent_usage_sessions")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray()) as unknown as UsageSessionLite[]
    if (match[0]) return match[0]
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/** Count scheduler recurring tasks bound to a channel (TER-650/G7 cleanup). */
export async function getRecurringTaskCount(channelId: string): Promise<number> {
  const db = await getMongoDb()
  return db.collection("scheduler_recurring_tasks").countDocuments({ channel_id: channelId })
}

/** Count scheduler reminders bound to a channel (TER-650/G7 cleanup). */
export async function getReminderCount(channelId: string): Promise<number> {
  const db = await getMongoDb()
  return db.collection("scheduler_reminders").countDocuments({ channel_id: channelId })
}

/** All agent_usage_sessions for a channel, newest first. */
export async function getUsageSessionsByChannel(channelId: string): Promise<UsageSessionLite[]> {
  const db = await getMongoDb()
  return db
    .collection("agent_usage_sessions")
    .find({ channelId })
    .sort({ createdAt: -1 })
    .toArray() as unknown as Promise<UsageSessionLite[]>
}

/**
 * Poll agent_usage_sessions until a session for `channelId` appears (optionally
 * matching a specific triggerKind). The session is written at session.started —
 * before the LLM answers — so this resolves regardless of the model outcome.
 */
export async function waitForUsageSession(
  channelId: string,
  opts: { triggerKind?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<UsageSessionLite | null> {
  const { triggerKind, timeoutMs = 90_000, pollMs = 1500 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sessions = await getUsageSessionsByChannel(channelId)
    const match = triggerKind ? sessions.find((s) => s.triggerKind === triggerKind) : sessions[0]
    if (match) return match
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/**
 * Subscribe a channel to a scheduler topic in `wake` mode so the dispatch
 * (`dispatchToChannelSubscriptions`) matches and wakes the agent. The WS action
 * `scheduler.create-recurring-task` does NOT create this subscription (the MCA
 * scheduler flow does); the scheduler re-creates it via `ensureSubscriptionForChannel`
 * on the first empty dispatch, but creating it upfront makes the test
 * deterministic on the first tick. Verified end-to-end (TER-650).
 */
export async function subscribeChannelToScheduler(
  channelId: string,
  topic = "scheduler.recurring_task",
): Promise<void> {
  const db = await getMongoDb()
  await db.collection("channel_event_subscriptions").insertOne({
    id: `sub_${Math.random().toString(36).slice(2, 10)}`,
    topic,
    channelId,
    rules: [{ channelId }],
    mode: "wake",
    createdAt: new Date(),
    lastActivityAt: new Date(),
  })
}

/**
 * Force any recurring task on a channel to be due now so the next scheduler
 * tick (every ~30s) dispatches it. Returns how many tasks were marked due.
 */
export async function forceRecurringTaskDue(channelId: string): Promise<number> {
  const db = await getMongoDb()
  const res = await db
    .collection("scheduler_recurring_tasks")
    .updateMany({ channel_id: channelId }, { $set: { next_run: Date.now() - 1000 } })
  return res.modifiedCount
}

/** Remove recurring tasks for a channel (test cleanup). */
export async function deleteRecurringTasksForChannel(channelId: string): Promise<void> {
  const db = await getMongoDb()
  await db.collection("scheduler_recurring_tasks").deleteMany({ channel_id: channelId })
}

/** Remove reminders for a channel (test cleanup — symmetric to the recurring-task helper). */
export async function deleteRemindersForChannel(channelId: string): Promise<void> {
  const db = await getMongoDb()
  await db.collection("scheduler_reminders").deleteMany({ channel_id: channelId })
}
