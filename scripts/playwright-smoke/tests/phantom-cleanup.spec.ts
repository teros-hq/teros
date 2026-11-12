/**
 * TER-650/G7 — a starter must not outlive its target (channel or agent).
 *
 * Root cause of the phantom-session incident: a recurring task / reminder outlived its
 * channel and kept firing every cron slot. Since c550f85bd those are Automate starters
 * (`automate_starters`, channel-event action) and the cascade lives in DeletionService:
 *   - deleteChannel deletes starters by `action.channelId` (deletion-service.ts, channel step)
 *   - deleteAgent runs the channel step for each of the agent's channels, THEN deletes
 *     starters by `action.agentId` (agent step). Reached from `agent.delete`.
 * `channel.close` only soft-closes since fed4941b9 (never deletes), so there is no longer
 * a "delete a private channel" path to test — the channel step is exercised through the
 * agent deletion instead.
 *
 * Fixture (agent test): starter A sits on the throwaway agent's channel but ACTS AS the
 * primary agent → only the channel step removes it; starter B acts as the throwaway agent
 * → the agent step removes it. Mutation: drop either `automate_starters` entry in
 * deletion-service → A or B survives → red.
 *
 * Deterministic and model-robust: NO LLM turn is driven — starters are written via the
 * real WS action and the deletion is observed directly in Mongo.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { closeDb } from "../helpers/db"
import { channelStarter, countStarters, deleteStartersForChannel } from "../helpers/automate"
import { attemptAction, evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"

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

/** Create a channel-bound starter through the real WS action (cron, never due in-test). */
async function createStarter(
  page: Page,
  workspaceId: string,
  channelId: string,
  agentId: string,
): Promise<void> {
  await wsRequest(page, "automate.create-starter", channelStarter(workspaceId, channelId, agentId))
}

test.describe("phantom-session cleanup (TER-650/G7) @usage", () => {
  test("deleting an agent removes the starters on its channels and the ones acting as it", async ({
    terosPage,
  }) => {
    const { agentId: primaryAgentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(primaryAgentId, "user1 agentId").toBeTruthy()
    const wid = privateWorkspaceId as string
    const agentId = await createThrowawayAgent(terosPage, wid)
    expect(agentId, "throwaway agentId").toBeTruthy()
    const channelId = await createChannel(terosPage, agentId, wid)

    try {
      await createStarter(terosPage, wid, channelId, primaryAgentId as string) // A: channel step
      await createStarter(terosPage, wid, channelId, agentId) // B: agent step
      expect(await countStarters({ channelId }), "fixture: 2 starters on the channel").toBe(2)

      await evalTeros(terosPage, (id) => window.teros.agent.deleteAgent(id), agentId)

      expect(
        await countStarters({ channelId }),
        "the starters on the agent's channel do NOT survive the agent deletion",
      ).toBe(0)
      expect(
        await countStarters({ agentId }),
        "the starters acting as the agent do NOT survive the agent deletion",
      ).toBe(0)
    } finally {
      await deleteStartersForChannel(channelId)
      await closeChannel(terosPage, channelId)
      await deleteAgent(terosPage, agentId)
    }
  })

  test("a stranger cannot delete another user's channel/agent nor clean up their starters @security", async ({
    terosPage,
    user2Page,
  }) => {
    // Negative authz: the cleanup side-effect must be gated behind ownership. user1 owns a
    // channel + agent with a starter; user2 (not a member of user1's private workspace) must
    // be denied AND user1's starter must survive. Mutation: drop the ownerId scoping in
    // agent/delete or canAccessChannel in channel/close → user2's call resolves (and an agent
    // delete would cascade the starter away) → the assertions go red.
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    const wid = privateWorkspaceId as string
    const channelId = await createChannel(terosPage, agentId as string, wid)

    try {
      await createStarter(terosPage, wid, channelId, agentId as string)
      expect(await countStarters({ channelId }), "fixture: 1 starter").toBe(1)

      // user2 tries to close user1's channel → UNAUTHORIZED (channel/close.ts).
      const closeAttempt = await attemptAction(user2Page, "channel.close", { channelId })
      expect(closeAttempt.resolved, "user2 must NOT close user1's channel").toBe(false)
      expect(closeAttempt.code, "foreign channel close → UNAUTHORIZED").toBe("UNAUTHORIZED")

      // user2 tries to delete user1's (primary) agent → ACCESS_DENIED: the agent exists
      // but user2 is no member of its workspace (MUW-REQ-3, canAccessAgent).
      // Safe: denial means the agent is NOT deleted.
      const deleteAttempt = await attemptAction(user2Page, "agent.delete", { agentId })
      expect(deleteAttempt.resolved, "user2 must NOT delete user1's agent").toBe(false)
      expect(deleteAttempt.code, "foreign agent delete → ACCESS_DENIED").toBe("ACCESS_DENIED")

      // The load-bearing invariant: user1's starter SURVIVES the denied calls.
      expect(
        await countStarters({ channelId }),
        "user1's starter survives the stranger's denied calls",
      ).toBe(1)
    } finally {
      await deleteStartersForChannel(channelId)
      await closeChannel(terosPage, channelId)
    }
  })
})
