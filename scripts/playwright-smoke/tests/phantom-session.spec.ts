/**
 * TER-650 — real triggerKind of usage sessions (the dashboard symptom).
 *
 * The phantom-session incident exposed that ALL non-user sessions were recorded as
 * `triggerKind='user_message'`, hiding their origin: a scheduler recurring task showed
 * up in the dashboard as "user_message" (exactly the bug's screenshot). The fix (area C
 * of TER-650) populates the real origin.
 *
 * This spec verifies it end-to-end against Mongo:
 *   1. a scheduler recurring task opens a session with triggerKind='scheduled'
 *   2. a direct user message still records triggerKind='user_message'
 *
 * The session is persisted when the turn STARTS (session.started), before the LLM
 * answers, so the assertion is robust to the model outcome (it does not depend on
 * Fireworks credentials or the replay cassette).
 *
 * Mutation check: reverting area C (triggerKind always user_message) makes test 1 never
 * find a 'scheduled' session → red.
 *
 * VALIDATED end-to-end against the real backend (2026-07-07): the fix produces the
 * 'scheduled' session. Environment requirements (met by the harness stack): the backend
 * under test must be the scheduler LEADER (a single backend on the DB — if another
 * backend shares the DB and holds the leader lock, it processes the dispatch); the
 * channel must be subscribed to the topic (created by `subscribeChannelToScheduler`,
 * since the WS action does not); the core model must exist in the `models` collection
 * and the user must have an active sub (seed + boot migrations).
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { closeDb } from "../helpers/db"
import { openChat } from "../helpers/dom"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"
import {
  deleteRecurringTasksForChannel,
  forceRecurringTaskDue,
  subscribeChannelToScheduler,
  waitForUsageSession,
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

/** Wait for a session on the channel and assert its triggerKind. */
async function expectSessionTriggerKind(
  channelId: string,
  kind: string,
  timeoutMs: number,
): Promise<void> {
  const session = await waitForUsageSession(channelId, { triggerKind: kind, timeoutMs })
  expect(session, `the channel's session must record triggerKind='${kind}'`).not.toBeNull()
  expect(session?.triggerKind).toBe(kind)
}

test.describe("usage triggerKind (TER-650) @usage", () => {
  test("a scheduler recurring task records the session as triggerKind='scheduled'", async ({
    terosPage,
  }) => {
    test.setTimeout(150_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    await ensureTerosProvider(terosPage, agentId as string)
    const channelId = await createChannel(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
    )
    expect(channelId, "ch_<16hex>").toMatch(/^ch_[0-9a-f]{16}$/)

    try {
      const created = await wsRequest(terosPage, "scheduler.create-recurring-task", {
        channelId,
        message: "scheduled daily report",
        cronExpression: "0 9 * * *",
      })
      expect(created, "create-recurring-task returned the task").toBeTruthy()

      // The WS action does not create the channel subscription; without it the dispatch does not match.
      await subscribeChannelToScheduler(channelId)
      const forced = await forceRecurringTaskDue(channelId)
      expect(forced, "the recurring task was marked as due").toBeGreaterThan(0)

      await expectSessionTriggerKind(channelId, "scheduled", 120_000)
    } finally {
      await deleteRecurringTasksForChannel(channelId)
      await closeChannel(terosPage, channelId)
    }
  })

  test("a direct user message records the session as triggerKind='user_message'", async ({
    terosPage,
  }) => {
    test.setTimeout(90_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    await ensureTerosProvider(terosPage, agentId as string)

    // Open a chat and send a message through the composer (real user flow).
    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWtrig${Date.now()}`,
    )
    try {
      const input = terosPage.getByTestId("composer-input")
      await input.fill("hola")
      await input.press("Enter")

      await expectSessionTriggerKind(channelId, "user_message", 60_000)
    } finally {
      await closeChannel(terosPage, channelId)
    }
  })
})
