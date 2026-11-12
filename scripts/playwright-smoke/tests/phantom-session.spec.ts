/**
 * TER-650 — real triggerKind of usage sessions (the dashboard symptom).
 *
 * The phantom-session incident exposed that ALL non-user sessions were recorded as
 * `triggerKind='user_message'`, hiding their origin: a scheduler recurring task showed
 * up in the dashboard as "user_message" (exactly the bug's screenshot). The fix (area C
 * of TER-650) populates the real origin.
 *
 * This spec verifies it end-to-end against Mongo:
 *   1. a scheduled Automate starter run opens a session with triggerKind='scheduled'
 *   2. a direct user message still records triggerKind='user_message'
 *
 * The session is persisted when the turn STARTS (session.started), before the LLM
 * answers, so the assertion is robust to the model outcome (it does not depend on
 * Fireworks credentials or the replay cassette).
 *
 * Mutation check: reverting area C (triggerKind always user_message) makes test 1 never
 * find a 'scheduled' session → red.
 *
 * Since c550f85bd the scheduler is Automate: a `once` channel-event starter due now is
 * claimed by the runner's next tick (5s after boot, then every 60s; the backend under test
 * must be the automate leader — a single backend on the DB) and delivered as a `reminder`
 * event → 'scheduled' (event-handler EVENT_TRIGGER_KIND). The run also passes the billing
 * gate + daily quota (seed + boot migrations + ensureTerosProvider); a refused run is
 * recorded in `automate_executions` with its reason.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { closeDb } from "../helpers/db"
import { composerInput, openChat } from "../helpers/dom"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"
import { channelStarter, deleteStartersForChannel } from "../helpers/automate"
import { waitForUsageSession } from "../helpers/usage"

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
  test("a scheduled Automate starter records the session as triggerKind='scheduled'", async ({
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
      // `once` due now → the runner's next tick fires it (no cron wait, no DB poking).
      const created = await wsRequest(
        terosPage,
        "automate.create-starter",
        channelStarter(privateWorkspaceId as string, channelId, agentId as string, {
          type: "once",
          at: new Date().toISOString(),
        }),
      )
      expect(created, "create-starter returned the starter").toBeTruthy()

      await expectSessionTriggerKind(channelId, "scheduled", 120_000)
    } finally {
      await deleteStartersForChannel(channelId)
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
      const input = composerInput(terosPage, channelId)
      await input.fill("hola")
      await input.press("Enter")

      await expectSessionTriggerKind(channelId, "user_message", 60_000)
    } finally {
      await closeChannel(terosPage, channelId)
    }
  })
})
