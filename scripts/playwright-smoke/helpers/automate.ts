/**
 * Automate starters for the specs — the only scheduling engine since c550f85bd
 * retired the legacy scheduler (scheduler.* WS actions + scheduler_* collections).
 * A channel-bound starter (`action.type: "channel-event"`) is what a reminder or a
 * recurring task became: `once` / `scheduler` trigger + a message for the agent.
 */
import { getMongoDb } from "./db"

/** `automate.create-starter` payload for a starter that wakes `agentId` in `channelId`. */
export function channelStarter(
  workspaceId: string,
  channelId: string,
  agentId: string,
  trigger: Record<string, unknown> = { type: "scheduler", cronExpression: "0 9 * * *" },
): Record<string, unknown> {
  return {
    workspaceId,
    name: `pw ${Date.now()}`,
    trigger,
    action: { type: "channel-event", channelId, agentId, eventTemplate: "daily report" },
  }
}

/** Count automate starters bound to a channel, or acting as an agent. */
export async function countStarters(f: { channelId: string } | { agentId: string }): Promise<number> {
  const db = await getMongoDb()
  const filter =
    "channelId" in f ? { "action.channelId": f.channelId } : { "action.agentId": f.agentId }
  return db.collection("automate_starters").countDocuments(filter)
}

/**
 * Test cleanup: `channel.close` only soft-closes (no cascade), so a leftover cron
 * starter would keep firing into the test DB. Removes every starter on the channel.
 */
export async function deleteStartersForChannel(channelId: string): Promise<void> {
  const db = await getMongoDb()
  await db.collection("automate_starters").deleteMany({ "action.channelId": channelId })
}
