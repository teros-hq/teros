/**
 * TER-650/G1+G4 — the billing session is bound to EXECUTION, not to the request.
 *
 * The fix changed the lifecycle: `session.started` opens the session as `queued` with
 * `startedAt=null`; when the ChannelWorker starts the turn, `onTurnStart` (← `awaitStart`)
 * fires `markRunning`, which moves it to `running` with a `startedAt` anchored to the
 * execution. Billing measures the execution `[startedAt, endedAt]` (NOT the queue-wait),
 * and a live turn is never closed to $0.
 *
 * This smoke verifies it end-to-end against Mongo, robust to the model outcome (it does
 * not depend on the LLM answering):
 *   - a real user turn takes the session out of `queued`: `startedAt` gets populated and
 *     the status advances to running/completed (it does not stay `queued`).
 *
 * Mutation check: breaking the `onTurnStart`→`markRunning` wiring (the session never
 * leaves `queued`) leaves `startedAt=null` and status `queued` → red. That is exactly the
 * hole that made the reconciler close live turns.
 *
 * Deep coverage (reconciler dual-cutoff, delta-guard, unbilled queue-wait) lives in the
 * real-Mongo tests `agent-usage-lifecycle-g1.test.ts`; here we verify the core→backend
 * wiring in the real user flow.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { closeDb } from "../helpers/db"
import { openChat } from "../helpers/dom"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds } from "../helpers/teros"
import { waitForSessionWhere } from "../helpers/usage"

test.afterAll(async () => {
  await closeDb()
})

function closeChannel(page: Page, channelId: string): Promise<unknown> {
  return evalTeros(page, (id) => window.teros.channel.close(id).catch(() => null), channelId)
}

test.describe("usage lifecycle bound to execution (TER-650/G1) @usage", () => {
  test("a real turn takes the session out of queued: startedAt anchored to execution", async ({
    terosPage,
  }) => {
    test.setTimeout(90_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    await ensureTerosProvider(terosPage, agentId as string)

    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PWlife${Date.now()}`,
    )
    try {
      const input = terosPage.getByTestId("composer-input")
      await input.fill("hola")
      await input.press("Enter")

      // The session must FLIP from queued→running (startedAt populated) as soon as the
      // worker starts the turn — even before the model answers.
      const session = await waitForSessionWhere(
        channelId,
        (s) => s.startedAt != null && s.status !== "queued",
        { timeoutMs: 60_000 },
      )

      expect(session, "there must be a session that left queued (markRunning fired)").not.toBeNull()
      // Anchored to EXECUTION: startedAt populated. Mutation: without markRunning →
      // startedAt=null and status queued → this assertion goes red.
      expect(session?.startedAt, "startedAt anchored to execution (not null)").not.toBeNull()
      expect(
        ["running", "completed", "errored", "aborted", "timed_out"],
        "status out of 'queued'",
      ).toContain(session?.status)
      // A freshly-started turn CANNOT have been closed by the reconciler.
      expect(session?.errorKind, "a live turn is not reconciled_timeout").not.toBe(
        "reconciled_timeout",
      )
    } finally {
      await closeChannel(terosPage, channelId)
    }
  })

  test("a completed teros turn lands the delta's tokens AND latency (TER-691) @llm", async ({
    terosPage,
  }) => {
    test.setTimeout(120_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    await ensureTerosProvider(terosPage, agentId as string)

    const channelId = await openChat(
      terosPage,
      agentId as string,
      privateWorkspaceId as string,
      `PW691-${Date.now()}`,
    )
    try {
      const input = terosPage.getByTestId("composer-input")
      await input.fill("di solo la palabra: hola")
      await input.press("Enter")

      // RC1 (TER-691): on the real path `session.ended` is applied BEFORE
      // `session.delta` (the delta callback is fire-and-forget, not awaited by
      // flushCallbacks), so the buggy `{status:"running"}` guard dropped the $inc
      // → a `completed` session stuck at 0 tokens / no latency (Model Health
      // blank, the reported symptom). With the fix the delta lands regardless of
      // order. Under the bug this predicate NEVER matches → the poll times out →
      // the test goes red. This is the end-to-end guard for the fix.
      const session = await waitForSessionWhere(
        channelId,
        (s) => s.status === "completed" && s.totalTokens > 0,
        { timeoutMs: 110_000 },
      )

      expect(
        session,
        "TER-691: a completed teros turn must carry the delta's tokens (not dropped)",
      ).not.toBeNull()
      expect(session?.totalTokens ?? 0, "tokens landed on the completed session").toBeGreaterThan(0)
      // The reported symptom was Model Health blank: latency never reached the
      // session because the SAME dropped delta carried it.
      expect(
        typeof session?.latencyMs === "number" && (session?.latencyMs as number) > 0,
        "TER-691: latency landed on the completed session (Model Health)",
      ).toBe(true)
      expect(session?.errorKind, "a clean turn is not reconciled_timeout").not.toBe(
        "reconciled_timeout",
      )
    } finally {
      await closeChannel(terosPage, channelId)
    }
  })
})
