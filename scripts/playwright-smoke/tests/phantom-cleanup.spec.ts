/**
 * TER-650/G7 — deleting a channel or an agent cleans up its scheduler tasks.
 *
 * Root cause of the phantom-session incident: a recurring task / reminder outlived
 * its channel. The scheduler kept firing it every cron slot (failing ownership)
 * until the failure cap disabled it — wasted dispatches and a stray heartbeat. The
 * fix binds the task's lifetime to its channel's, via TWO paths:
 *   - `ChannelManager.deleteChannelCompletely` deletes `scheduler_recurring_tasks`
 *     + `scheduler_reminders` by `channel_id` (channel-manager.ts:599-602). It is
 *     reached via `channel.close` ONLY when the channel is private
 *     (channel-manager.ts:565); a non-private channel only flips to `status:closed`
 *     and cleans nothing.
 *   - `agent.delete` resolves the agent's channels (`channels.agentId`) and deletes
 *     the scheduler docs by `channel_id ∈ channelIds` (agent/delete.ts:47-61). The
 *     key is `channel_id`, NOT `agent_id`.
 *
 * These tests are the ONLY G7 coverage (no unit): they exercise the cross-layer
 * wiring WS → ChannelManager/handler → scheduler collections against Mongo, plus a
 * negative authz case (a stranger cannot delete another user's channel/agent nor
 * clean up their scheduler).
 *
 * Mutation check (channel): drop the two `deleteMany` at channel-manager.ts:599-602
 * → the recurring task and reminder survive the close → `=== 0` goes red.
 * Mutation check (agent): drop the `deleteMany` block at agent/delete.ts:52-61 →
 * they survive → red. (The fixture binds the tasks by `channel_id` of a channel of
 * the agent, so the correct path — resolve channels, delete by channel_id — is the
 * only one that cleans them; a mutant deleting by `agent_id` would not touch them.)
 *
 * Deterministic and model-robust: NO LLM turn is driven. Creating the recurring
 * task/reminder only writes the row (no subscription or dispatch needed), and the
 * deletion is observed directly in Mongo.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { closeDb } from "../helpers/db"
import { attemptAction, evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"
import {
  deleteRecurringTasksForChannel,
  deleteRemindersForChannel,
  getRecurringTaskCount,
  getReminderCount,
} from "../helpers/usage"

test.afterAll(async () => {
  await closeDb()
})

/** Create an ephemeral channel via the client and return its id. */
function createChannel(page: Page, agentId: string, workspaceId: string): Promise<string> {
  return evalTeros(
    page,
    ({ aid, wid }) =>
      window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
    { aid: agentId, wid: workspaceId },
  )
}

/** Best-effort close of a test channel (never throws in cleanup). */
function closeChannel(page: Page, channelId: string): Promise<unknown> {
  return evalTeros(page, (id) => window.teros.channel.close(id).catch(() => null), channelId)
}

/** Create a throwaway agent (owned by user1) — never the primary shared agent. */
function createThrowawayAgent(page: Page, workspaceId: string): Promise<string> {
  return evalTeros(
    page,
    async (wid) => {
      const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
      const r = await window.teros.agent.createAgent({
        coreId,
        name: "PwG7",
        fullName: `Pw G7 ${Date.now()}`,
        role: "tester",
        intro: "G7 cleanup smoke agent",
        workspaceId: wid,
      })
      return r.agent.agentId
    },
    workspaceId,
  )
}

/** Best-effort delete of a throwaway agent (never throws in cleanup). */
function deleteAgent(page: Page, agentId: string): Promise<unknown> {
  return evalTeros(page, (id) => window.teros.agent.deleteAgent(id).catch(() => null), agentId)
}

/**
 * Bind a recurring task + a reminder to a channel via the real WS actions, then
 * assert the fixture actually landed (guard: if these are 0, the test proves
 * nothing). `create-recurring-task`/`schedule-reminder` params verified against the handlers.
 */
async function seedSchedulerDocs(page: Page, channelId: string): Promise<void> {
  await wsRequest(page, "scheduler.create-recurring-task", {
    channelId,
    message: "daily report",
    cronExpression: "0 9 * * *",
  })
  await wsRequest(page, "scheduler.schedule-reminder", {
    channelId,
    message: "reminder",
    time: "in 1 hour",
  })
  expect(await getRecurringTaskCount(channelId), "fixture: 1 recurring task created").toBe(1)
  expect(await getReminderCount(channelId), "fixture: 1 reminder created").toBe(1)
}

/** Remove any scheduler docs left over if the test failed before the delete. */
async function cleanupScheduler(channelId: string): Promise<void> {
  await deleteRecurringTasksForChannel(channelId)
  await deleteRemindersForChannel(channelId)
}

test.describe("phantom-session cleanup (TER-650/G7) @usage", () => {
  test("deleting a private channel cleans up its scheduler recurring tasks + reminders", async ({
    terosPage,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    const channelId = await createChannel(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
    )
    expect(channelId, "ch_<16hex>").toMatch(/^ch_[0-9a-f]{16}$/)

    try {
      await seedSchedulerDocs(terosPage, channelId)

      // A channel is created NON-private (createChannel does not set isPrivate).
      // Marking it private is what makes `channel.close` → `deleteChannelCompletely`.
      await wsRequest(terosPage, "channel.set-private", { channelId, isPrivate: true })
      await evalTeros(terosPage, (id) => window.teros.channel.close(id), channelId)

      // The G7 cascade: both collections empty for this channel.
      expect(
        await getRecurringTaskCount(channelId),
        "the recurring task does NOT survive the channel deletion",
      ).toBe(0)
      expect(
        await getReminderCount(channelId),
        "the reminder does NOT survive the channel deletion",
      ).toBe(0)
    } finally {
      await cleanupScheduler(channelId)
      await closeChannel(terosPage, channelId)
    }
  })

  test("deleting an agent cleans up its channels' recurring tasks + reminders", async ({
    terosPage,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "user1 privateWorkspaceId").toBeTruthy()
    const wid = privateWorkspaceId as string
    const agentId = await createThrowawayAgent(terosPage, wid)
    expect(agentId, "throwaway agentId").toBeTruthy()
    const channelId = await createChannel(terosPage, agentId, wid)
    expect(channelId, "ch_<16hex>").toMatch(/^ch_[0-9a-f]{16}$/)

    try {
      await seedSchedulerDocs(terosPage, channelId)

      // Deleting the agent resolves its channels and cleans the scheduler by channel_id.
      await evalTeros(terosPage, (id) => window.teros.agent.deleteAgent(id), agentId)

      expect(
        await getRecurringTaskCount(channelId),
        "the recurring task of the agent's channel does NOT survive the agent deletion",
      ).toBe(0)
      expect(
        await getReminderCount(channelId),
        "the reminder of the agent's channel does NOT survive the agent deletion",
      ).toBe(0)
    } finally {
      await cleanupScheduler(channelId)
      await closeChannel(terosPage, channelId)
      await deleteAgent(terosPage, agentId)
    }
  })

  test("a stranger cannot delete another user's channel/agent nor clean up their scheduler @security", async ({
    terosPage,
    user2Page,
  }) => {
    // Negative authz: the cleanup side-effect must be gated behind ownership. user1
    // owns a private-workspace channel + agent with scheduler tasks; user2 (neither
    // owner nor member of user1's private workspace) must be denied AND user1's
    // scheduler tasks must survive. Mutation: drop the ownerId scoping in agent/delete
    // or canAccessChannel in channel/close → user2's call resolves + the scheduler is
    // cleaned → the survival assertions go red.
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    const channelId = await createChannel(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
    )
    expect(channelId, "ch_<16hex>").toMatch(/^ch_[0-9a-f]{16}$/)

    try {
      await seedSchedulerDocs(terosPage, channelId)

      // user2 tries to close user1's private channel → UNAUTHORIZED (channel/close.ts:28).
      const closeAttempt = await attemptAction(user2Page, "channel.close", { channelId })
      expect(closeAttempt.resolved, "user2 must NOT close user1's channel").toBe(false)
      expect(closeAttempt.code, "foreign channel close → UNAUTHORIZED").toBe("UNAUTHORIZED")

      // user2 tries to delete user1's (primary) agent → AGENT_NOT_FOUND (ownerId scoping).
      // Safe: denial means the agent is NOT deleted.
      const deleteAttempt = await attemptAction(user2Page, "agent.delete", { agentId })
      expect(deleteAttempt.resolved, "user2 must NOT delete user1's agent").toBe(false)
      expect(deleteAttempt.code, "foreign agent delete → AGENT_NOT_FOUND").toBe("AGENT_NOT_FOUND")

      // The load-bearing invariant: user1's scheduler tasks SURVIVE the denied calls.
      expect(
        await getRecurringTaskCount(channelId),
        "user1's recurring task survives the stranger's denied calls",
      ).toBe(1)
      expect(
        await getReminderCount(channelId),
        "user1's reminder survives the stranger's denied calls",
      ).toBe(1)
    } finally {
      await cleanupScheduler(channelId)
      await closeChannel(terosPage, channelId)
    }
  })
})
