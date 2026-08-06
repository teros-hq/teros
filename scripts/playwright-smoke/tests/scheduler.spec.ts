/**
 * Scheduler write-time guards (TER-483 / #174). The two write actions
 * (schedule-reminder, create-recurring-task) used to accept ANY non-empty string
 * as channelId and a channel the caller did not own — a reminder/task aimed at a
 * foreign or malformed channel was stored and failed silently days later at
 * dispatch. The fix: `assertValidChannelId` (shape `ch_<16hex>`) then
 * `assertChannelOwnership` (strict owner), in that order, before the write.
 *
 * security.spec already covers schedule-reminder ownership; this file adds:
 *  - create-recurring-task ownership (stranger on user1's channel → FORBIDDEN)
 *  - malformed channelId rejection for BOTH actions (→ INVALID_INPUT), which the
 *    owner himself triggers (it's input validation, not authz).
 *
 * Mutation check: no-op assertChannelOwnership → the stranger's create-recurring-task
 * resolves (red); no-op assertValidChannelId → the malformed-id calls stop being
 * INVALID_INPUT (they fall through to a different code) → red.
 */
import { expect, test } from "../fixtures"
import { attemptAction, evalTeros, getPrimaryIds } from "../helpers/teros"

type Denial = { resolved: boolean; message: string | null; code: string | null }
function expectDenied(r: Denial, code: string, msgContains: string, label: string): void {
  expect(r.resolved, `${label}: debía ser DENEGADO pero tuvo ÉXITO`).toBe(false)
  expect(r.code, `${label}: code`).toBe(code)
  expect(r.message ?? "", `${label}: message`).toContain(msgContains)
}

test.describe("scheduler — guards de escritura (ownership + shape) @security", () => {
  test("user2 no puede crear una recurring-task en un canal de user1", async ({
    terosPage,
    user2Page,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    const channelId = await evalTeros(
      terosPage,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId, wid: privateWorkspaceId },
    )
    expect(channelId, "canal ch_<16hex>").toMatch(/^ch_[0-9a-f]{16}$/)
    try {
      // Valid-shape channelId owned by user1 → the gate decides by ownership.
      expectDenied(
        await attemptAction(user2Page, "scheduler.create-recurring-task", {
          channelId,
          message: "intruso",
          cronExpression: "0 9 * * *",
        }),
        "FORBIDDEN",
        "does not belong to user",
        "scheduler.create-recurring-task",
      )
    } finally {
      await evalTeros(terosPage, (id) => window.teros.channel.close(id).catch(() => null), channelId)
    }
  })

  test("un channelId con formato inválido es rechazado (INVALID_INPUT) en ambas acciones", async ({
    terosPage,
  }) => {
    // Owner drives this — it's shape validation, not authz. A non-empty garbage
    // string used to be accepted; now it must fail INVALID_INPUT before the write.
    const garbage = "not-a-channel-id"
    expectDenied(
      await attemptAction(terosPage, "scheduler.schedule-reminder", {
        channelId: garbage,
        message: "x",
        time: "in 1 hour",
      }),
      "INVALID_INPUT",
      "channelId must match",
      "schedule-reminder (bad shape)",
    )
    expectDenied(
      await attemptAction(terosPage, "scheduler.create-recurring-task", {
        channelId: garbage,
        message: "x",
        cronExpression: "0 9 * * *",
      }),
      "INVALID_INPUT",
      "channelId must match",
      "create-recurring-task (bad shape)",
    )
  })
})
