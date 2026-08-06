/**
 * I4 — Limit UX, DOM (TER-596 / TER-602). The backend-contract specs
 * (billing-limit-ux, billing-chat-block) drive the gate/boost through the client;
 * THIS spec operates the rendered UI as playwright2: the 100% block widget inside
 * a real chat, the BoostModal buy form (stepper → purchase → done), the team
 * request form, and the unavailable state — asserting the raw Mongo effect.
 */
import { expect, test } from "../fixtures"
import {
  getAccessRequests,
  getBillingCustomer,
  getBoosts,
  insertInvoice,
  KIMI_USER,
  resetKimiBaseline,
  resetTeamBaseline,
  resetUserPlan,
  setDefaultPaymentMethod,
  setSubTeam,
  setUsed,
} from "../helpers/billing"
import { closeDb } from "../helpers/db"
import { fillStripeCard, openBoostModalViaBanner, openChat } from "../helpers/dom"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

test.beforeEach(async () => {
  await resetKimiBaseline()
})
test.afterAll(async () => {
  await resetKimiBaseline()
  await resetTeamBaseline()
  await closeDb()
})

test.describe("billing — UX de límite I4 (DOM) @billing", () => {
  test("chat 100%: el widget de bloqueo se renderiza y su CTA abre el BoostModal", async ({
    user2Page,
  }) => {
    test.setTimeout(70_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(user2Page)
    expect(agentId, "playwright2 tiene agente").toBeTruthy()
    await ensureTerosProvider(user2Page, agentId as string)
    await setUsed(KIMI_USER, 85) // por encima del límite Pro (80)

    const channelId = await openChat(
      user2Page,
      agentId as string,
      privateWorkspaceId as string,
      `PWlimit${Date.now()}`,
    )
    // Enviar un mensaje por el composer (DOM) → el gate corta el turno → ErrorBlock
    // renderiza el HoursExhaustedWidget en el chat.
    const input = user2Page.getByTestId("composer-input")
    await input.fill("hola")
    await input.press("Enter")

    await expect(user2Page.getByTestId("hours-exhausted-widget")).toBeVisible({ timeout: 30_000 })
    // El cuerpo enmarca el bloqueo con el plan (Pro) — el carrier planName de I4.
    await expect(user2Page.getByTestId("hours-exhausted-body")).toContainText("Pro")
    await expect(user2Page.getByTestId("exhausted-upgrade")).toBeVisible()

    // El CTA "conseguir más horas" abre el BoostModal.
    await user2Page.getByTestId("exhausted-boost").click()
    await expect(user2Page.getByTestId("boost-panel")).toBeVisible({ timeout: 10_000 })

    await evalTeros(user2Page, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("BoostModal compra individual: el stepper mueve el total y comprar concede el boost", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000) // la compra cobra la tarjeta vía Stripe
    await openBoostModalViaBanner(user2Page)

    // Buy form (plan_pro metered + tarjeta). El stepper mueve el total (horas × €3).
    await expect(user2Page.getByTestId("boost-buy")).toBeVisible({ timeout: 10_000 })
    const totalBefore = (await user2Page.getByTestId("boost-total").textContent()) ?? ""
    await user2Page.getByTestId("boost-hours-inc").click()
    await expect
      .poll(async () => (await user2Page.getByTestId("boost-total").textContent()) ?? "", {
        timeout: 5000,
        message: "el stepper actualiza el total",
      })
      .not.toBe(totalBefore)

    // Comprar → cobra la tarjeta + concede el boost → pantalla de éxito.
    await user2Page.getByTestId("boost-buy").click()
    await expect(user2Page.getByTestId("boost-done")).toBeVisible({ timeout: 25_000 })

    // Mongo: un boost activo concedido.
    const boosts = await getBoosts(KIMI_USER)
    expect(boosts.length, "un boost concedido").toBe(1)
    expect(boosts[0]?.status).toBe("active")
  })

  test("BoostModal modo equipo: la solicitud no cobra y queda pendiente", async ({ user2Page }) => {
    test.setTimeout(60_000)
    await setSubTeam(KIMI_USER, "team_demo")
    await openBoostModalViaBanner(user2Page)

    // Miembro de equipo → formulario de solicitud (no compra).
    await expect(user2Page.getByTestId("boost-request")).toBeVisible({ timeout: 10_000 })
    await user2Page.getByTestId("boost-reason").fill("necesito más horas para el sprint")
    await user2Page.getByTestId("boost-request").click()
    await expect(user2Page.getByTestId("boost-done")).toBeVisible({ timeout: 15_000 })

    // Mongo: una solicitud pendiente, sin boost (es solicitud, no compra).
    const reqs = await getAccessRequests(KIMI_USER)
    expect(reqs.length, "una solicitud creada").toBe(1)
    expect(reqs[0]?.status).toBe("pending")
    // "No concede horas" = ESTA solicitud no tiene un boost asociado. Filtramos por
    // accessRequestId (no el conteo global): una compra de boost lenta de un test
    // previo puede aterrizar tarde con accessRequestId=null, contaminando el global —
    // este aserto es inmune a esa fuga y sigue mordiendo el fallo real (si el path de
    // solicitud concediera un boost, llevaría accessRequestId = este reqId).
    const reqId = reqs[0]?._id
    const boostsForReq = (await getBoosts(KIMI_USER)).filter((b) => b.accessRequestId === reqId)
    expect(boostsForReq.length, "la solicitud no concede horas (es solicitud, no compra)").toBe(0)
  })

  test("BoostModal en plan no-metered (Enterprise): muestra 'no disponible'", async ({
    user2Page,
  }) => {
    test.setTimeout(60_000)
    await resetUserPlan(KIMI_USER, "plan_enterprise")
    await openBoostModalViaBanner(user2Page)
    await expect(user2Page.getByTestId("boost-unavailable")).toBeVisible({ timeout: 10_000 })
  })

  test("bloqueo por impago (F9): el PaymentDueWidget se renderiza en el chat", async ({
    user2Page,
  }) => {
    test.setTimeout(70_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(user2Page)
    expect(agentId, "playwright2 tiene agente").toBeTruthy()
    await ensureTerosProvider(user2Page, agentId as string)
    // Factura bloqueante (decision B/F9): uncollectible → el choke point de resolución
    // de provider lanza PaymentDueError ANTES del LLM, para cualquier modelo (incl. BYOK).
    await insertInvoice(KIMI_USER, { status: "uncollectible", amount: 179 })

    const channelId = await openChat(
      user2Page,
      agentId as string,
      privateWorkspaceId as string,
      `PWdue${Date.now()}`,
    )
    const input = user2Page.getByTestId("composer-input")
    await input.fill("hola")
    await input.press("Enter")

    // ErrorBlock renderiza el PaymentDueWidget (reason 'payment_due'), no el de horas.
    await expect(user2Page.getByTestId("payment-due-widget")).toBeVisible({ timeout: 30_000 })

    await evalTeros(user2Page, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test('chat 100%: el CTA "Subir de plan" abre el perfil en la sección de plan', async ({
    user2Page,
  }) => {
    test.setTimeout(70_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(user2Page)
    expect(agentId, "playwright2 tiene agente").toBeTruthy()
    await ensureTerosProvider(user2Page, agentId as string)
    await setUsed(KIMI_USER, 85)

    const channelId = await openChat(
      user2Page,
      agentId as string,
      privateWorkspaceId as string,
      `PWupg${Date.now()}`,
    )
    const input = user2Page.getByTestId("composer-input")
    await input.fill("hola")
    await input.press("Enter")
    await expect(user2Page.getByTestId("hours-exhausted-widget")).toBeVisible({ timeout: 30_000 })

    // El CTA "Subir de plan" llama openWindow('profile',{initialMode:'plan'}) → la
    // ventana de Perfil se abre directamente en la sección de plan (UsageHero).
    await user2Page.getByTestId("exhausted-upgrade").click()
    await expect(user2Page.getByTestId("plan-hero")).toBeVisible({ timeout: 15_000 })
    await expect(user2Page.getByTestId("plan-hero")).toContainText("Pro")

    await evalTeros(user2Page, (cid) => window.teros.channel.close(cid).then(() => null), channelId)
  })

  test("BoostModal sin método de pago: NO_PAYMENT_METHOD → formulario → re-vault → reintento concede el boost", async ({
    user2Page,
  }) => {
    test.setTimeout(140_000) // re-vault con Stripe Elements + cobro de la compra
    // Capturamos la PM por defecto para restaurar el baseline al final (resetKimiBaseline
    // NO toca billing_customers).
    const cust = await getBillingCustomer(KIMI_USER)
    const originalPm = (cust?.defaultPaymentMethodId as string | null) ?? null
    // Sin PM por defecto → la compra lanza NO_PAYMENT_METHOD (gate de purchase-boost).
    await setDefaultPaymentMethod(KIMI_USER, null)
    try {
      await openBoostModalViaBanner(user2Page)
      await expect(user2Page.getByTestId("boost-buy")).toBeVisible({ timeout: 10_000 })

      // Comprar sin PM → el backend responde NO_PAYMENT_METHOD → la BuyForm pasa a
      // "need_card" y monta el PaymentMethodSetup (mismo reqId para el reintento, C3).
      await user2Page.getByTestId("boost-buy").click()
      await expect(user2Page.getByTestId("payment-method-form")).toBeVisible({ timeout: 20_000 })

      // Rellenar la tarjeta 4242 y guardar → confirmSetup vault → set-payment-method →
      // onSuccess dispara el reintento de la compra con el MISMO reqId.
      await user2Page.getByTestId("payment-element").waitFor({ state: "visible", timeout: 20_000 })
      await fillStripeCard(user2Page)
      await user2Page.getByTestId("payment-method-save").click()

      // El reintento concede el boost → pantalla de éxito.
      await expect(user2Page.getByTestId("boost-done")).toBeVisible({ timeout: 40_000 })

      // Mongo: exactamente un boost activo (la idempotencia del reqId evita el doble cobro).
      const boosts = await getBoosts(KIMI_USER)
      expect(boosts.length, "un único boost concedido").toBe(1)
      expect(boosts[0]?.status).toBe("active")
    } finally {
      // Restaurar la PM documentada para que el smoke manual de Antonio la encuentre.
      await setDefaultPaymentMethod(KIMI_USER, originalPm)
    }
  })
})
