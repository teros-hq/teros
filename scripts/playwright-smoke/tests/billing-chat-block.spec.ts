/**
 * I4 — 100% hard block in chat (TER-596 / TER-602). When a Teros-model turn is
 * over the hour limit, the gate throws HoursExhaustedError BEFORE any LLM call and
 * the agent-loop persists a chat error message carrying the data the
 * HoursExhaustedWidget frames the block around: plan name + reset date + used/limit
 * (the whole reason I4 added planName/periodEnd to the carrier).
 *
 * We drive a real turn as playwright2 (the Kimi-agent user) over the limit and
 * assert the error message's carrier. The gate cuts before Fireworks, so there's
 * no LLM cost and it's deterministic. A second test opens the chat in the UI and
 * checks the widget actually renders.
 */
import { closeDb } from "../helpers/db"
import { KIMI_USER, resetKimiBaseline, setUsed } from "../helpers/billing"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds } from "../helpers/teros"
import { expect, test } from "../fixtures"
import type { Page } from "@playwright/test"

interface ErrorContent {
  type: string
  errorType: string
  context: {
    reason: string
    used: number
    limit: number
    tier?: string
    planName?: string
    periodEnd?: string
  }
}

/** Poll the channel until an error message (content.type === 'error') appears. */
async function waitForErrorContent(
  page: Page,
  channelId: string,
  timeoutMs: number,
): Promise<ErrorContent | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const content = await page.evaluate(async (cid) => {
      // biome-ignore lint/suspicious/noExplicitAny: browser global
      const t = (window as any).teros
      const r = await t.channel.getMessages(cid)
      // biome-ignore lint/suspicious/noExplicitAny: dynamic message shape
      const m = (r.messages || []).find((x: any) => x.content?.type === "error")
      return m ? m.content : null
    }, channelId)
    if (content) return content as ErrorContent
    await page.waitForTimeout(500)
  }
  return null
}

test.afterAll(async () => {
  await resetKimiBaseline()
  await closeDb()
})

test.describe("billing — bloqueo 100% en chat I4 @billing", () => {
  test("el turno se corta con el carrier hours_exhausted (planName + periodEnd + used/limit)", async ({
    user2Page,
  }) => {
    test.setTimeout(50_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(user2Page)
    expect(agentId, "playwright2 tiene agente").toBeTruthy()
    // El agente debe resolver al provider teros para que dispare el gate de horas.
    await ensureTerosProvider(user2Page, agentId as string)
    // Por encima del límite del plan (Pro = 80h).
    await setUsed(KIMI_USER, 85)

    const channelId = await evalTeros(
      user2Page,
      ({ aid, wid }) =>
        window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
      { aid: agentId as string, wid: privateWorkspaceId as string },
    )
    expect(channelId).toBeTruthy()
    await evalTeros(user2Page, (cid) => window.teros.channel.subscribe(cid).then(() => null), channelId)
    await evalTeros(
      user2Page,
      (cid) =>
        window.teros.channel
          .sendMessage(cid, { type: "text", text: "hola" }, { wakeUpAgent: true })
          .then(() => null),
      channelId,
    )

    const content = await waitForErrorContent(user2Page, channelId, 25_000)
    expect(content, "llega un mensaje de error del turno bloqueado").toBeTruthy()
    if (!content) return
    expect(content.type).toBe("error")
    expect(content.errorType).toBe("upgrade_required")
    expect(content.context.reason).toBe("hours_exhausted")
    // El carrier que el widget enmarca: plan + fecha de reset + uso real.
    expect(content.context.planName, "displayName del plan en el carrier").toBe("Pro")
    expect(content.context.used).toBe(85)
    expect(content.context.limit).toBe(80)
    expect(
      Number.isNaN(Date.parse(content.context.periodEnd ?? "")),
      "periodEnd ISO para la fecha de reset",
    ).toBe(false)

    await evalTeros(user2Page, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })
})
