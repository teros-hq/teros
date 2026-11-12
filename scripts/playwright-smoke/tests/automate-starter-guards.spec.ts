/**
 * Write-time guards of channel-bound Automate starters (TER-483 / #174, ported from the
 * legacy scheduler retired in c550f85bd). A reminder/recurring task is now an
 * `automate.create-starter` with a `channel-event` action; the original bug class still
 * applies — a starter aimed at a foreign or bogus channel must be rejected at write time,
 * not stored to fail silently at dispatch.
 *
 * The guard today is `validateChannelEventAction` (automate/_validation.ts): the channel
 * must exist AND belong to the starter's workspace, else VALIDATION_ERROR "Channel not
 * found in workspace". It covers both cases the old spec had (ownership + malformed id;
 * the old `ch_<16hex>` shape check / INVALID_INPUT no longer exists).
 *
 *  - stranger: user2, in HIS OWN workspace (so the workspace-role gate passes), points a
 *    starter at user1's channel → VALIDATION_ERROR. In user1's workspace he never gets
 *    that far → FORBIDDEN "Write access required" (workspace-role gate).
 *  - garbage channelId from the owner → VALIDATION_ERROR.
 *
 * Mutation check: drop the workspace match in validateChannelEventAction → the stranger's
 * starter is created (red); drop the channel lookup → the garbage id is accepted (red).
 */
import { expect, test } from "../fixtures"
import { channelStarter, deleteStartersForChannel } from "../helpers/automate"
import { closeDb } from "../helpers/db"
import { attemptAction, evalTeros, getPrimaryIds } from "../helpers/teros"

test.afterAll(async () => {
  await closeDb()
})

type Denial = { resolved: boolean; message: string | null; code: string | null }
function expectDenied(r: Denial, code: string, msgContains: string, label: string): void {
  expect(r.resolved, `${label}: debía ser DENEGADO pero tuvo ÉXITO`).toBe(false)
  expect(r.code, `${label}: code`).toBe(code)
  expect(r.message ?? "", `${label}: message`).toContain(msgContains)
}

test.describe("automate — guards de escritura de starters de canal @security", () => {
  test("user2 no puede crear un starter recurrente sobre un canal de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const u2 = await getPrimaryIds(user2Page)
    expect(u2.agentId, "agentId de user2").toBeTruthy()
    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId as string, wid: privateWorkspaceId as string },
    )
    try {
      // From user2's own workspace: the channel is not in it → rejected before the write.
      expectDenied(
        await attemptAction(
          user2Page,
          "automate.create-starter",
          channelStarter(u2.privateWorkspaceId as string, channelId, u2.agentId as string),
        ),
        "VALIDATION_ERROR",
        "Channel not found in workspace",
        "automate.create-starter (canal ajeno)",
      )
      // From user1's workspace: user2 has no role there → workspace-role gate.
      expectDenied(
        await attemptAction(
          user2Page,
          "automate.create-starter",
          channelStarter(privateWorkspaceId as string, channelId, agentId as string),
        ),
        "FORBIDDEN",
        "Write access required",
        "automate.create-starter (workspace ajeno)",
      )
    } finally {
      await deleteStartersForChannel(channelId)
      await evalTeros(terosPage, (id) => window.teros.channel.close(id).catch(() => null), channelId)
    }
  })

  test("un channelId inexistente/basura es rechazado (VALIDATION_ERROR)", async ({ terosPage }) => {
    // Owner drives this — it's input validation, not authz.
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    expectDenied(
      await attemptAction(
        terosPage,
        "automate.create-starter",
        channelStarter(privateWorkspaceId as string, "not-a-channel-id", agentId as string),
      ),
      "VALIDATION_ERROR",
      "Channel not found in workspace",
      "automate.create-starter (channelId basura)",
    )
  })
})
