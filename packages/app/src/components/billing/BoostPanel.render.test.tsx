/**
 * BoostPanel (TER-596 I4) — the logic half of the BoostModal, render-tested in
 * isolation (the Dialog portal chrome is covered by the live smoke). Assertions
 * that bite:
 *   - TEAM (teamId set)       → request form; submit hits requestAccess with the
 *     exact {requestedHours, reason} payload (reason omitted when blank) + toast,
 *   - INDIVIDUAL + pricing    → buy form; the total is hours × hourPrice; buy hits
 *     purchaseBoost(hours, reqId) and shows the bought state + toast,
 *   - INDIVIDUAL + no pricing → the "unavailable" notice (no buy form),
 *   - NO_PAYMENT_METHOD       → the card setup appears, and the retry reuses the
 *     SAME idempotency reqId (no double-charge) — the survivor-hunt assertion,
 *   - a load failure          → the load-error state.
 *
 *   cd packages/app && npx vitest run src/components/billing/BoostPanel.render.test.tsx
 */
import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { act } from "react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("@tamagui/lucide-icons", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>
  const StubIcon = () => null
  return { ...real, Minus: StubIcon, Plus: StubIcon, X: StubIcon }
})

const billing = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  purchaseBoost: vi.fn(),
  requestAccess: vi.fn(),
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => ({ billing }),
}))

const toastSpies = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
}))
vi.mock("../Toast", () => ({ useToast: () => toastSpies }))

// Capture the props PaymentMethodSetup is mounted with so we can drive its
// onSuccess (the user vaulting a card) without pulling in Stripe.js.
const pmHooks = vi.hoisted(() => ({ onSuccess: undefined as undefined | (() => void) }))
vi.mock("./PaymentMethodSetup", () => ({
  PaymentMethodSetup: (props: { onSuccess: () => void; onCancel: () => void }) => {
    pmHooks.onSuccess = props.onSuccess
    return null
  },
}))

import { BoostPanel } from "./BoostModal"

const onClose = vi.fn()

function renderPanel() {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <BoostPanel onClose={onClose} />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  for (const s of Object.values(billing)) s.mockReset()
  for (const s of Object.values(toastSpies)) s.mockClear()
  pmHooks.onSuccess = undefined
  onClose.mockClear()
})

describe("BoostPanel — team mode (request)", () => {
  it("renders the request form and submits the exact payload (reason omitted when blank)", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: "team_1" },
      paymentMethod: null,
      boostPricing: { hourPrice: 3, currency: "EUR" },
    })
    billing.requestAccess.mockResolvedValue({ request: { _id: "r1" } })
    const user = userEvent.setup()
    const { findByTestId, queryByTestId } = renderPanel()

    const submit = await findByTestId("boost-request")
    // Team mode: a request form, never the buy form / total.
    expect(queryByTestId("boost-buy")).toBeNull()
    expect(queryByTestId("boost-total")).toBeNull()

    await user.click(submit)
    expect(billing.requestAccess).toHaveBeenCalledWith({ requestedHours: 10, reason: undefined })
    await findByTestId("boost-done")
    expect(toastSpies.success).toHaveBeenCalledTimes(1)
  })
})

describe("BoostPanel — individual mode (buy)", () => {
  it("shows the total (hours × hourPrice) and buys with an idempotency reqId", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: null },
      paymentMethod: { brand: "visa", last4: "4242" },
      boostPricing: { hourPrice: 3, currency: "EUR" },
    })
    billing.purchaseBoost.mockResolvedValue({
      boostId: "b1",
      hours: 10,
      amount: 30,
      currency: "EUR",
      invoice: null,
      subscription: null,
    })
    const user = userEvent.setup()
    const { findByTestId, getByTestId } = renderPanel()

    const buy = await findByTestId("boost-buy")
    // MUST BITE: a fixed/ignored hourPrice would not show 30 for 10×3.
    expect(getByTestId("boost-total").textContent).toContain("30")

    await user.click(buy)
    expect(billing.purchaseBoost).toHaveBeenCalledTimes(1)
    const [hoursArg, reqIdArg] = billing.purchaseBoost.mock.calls[0]
    expect(hoursArg).toBe(10)
    expect(typeof reqIdArg).toBe("string")
    expect(reqIdArg.length).toBeGreaterThan(0)
    await findByTestId("boost-done")
    expect(toastSpies.success).toHaveBeenCalledTimes(1)
  })

  it("shows the unavailable notice when there is no boost pricing (no buy form)", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: null },
      paymentMethod: null,
      boostPricing: null,
    })
    const { findByTestId, queryByTestId } = renderPanel()
    await findByTestId("boost-unavailable")
    expect(queryByTestId("boost-buy")).toBeNull()
  })

  it("on NO_PAYMENT_METHOD surfaces card setup and retries with the SAME reqId", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: null },
      paymentMethod: null,
      boostPricing: { hourPrice: 3, currency: "EUR" },
    })
    // First attempt: no card. After vaulting, the retry succeeds.
    billing.purchaseBoost
      .mockRejectedValueOnce(Object.assign(new Error("no card"), { code: "NO_PAYMENT_METHOD" }))
      .mockResolvedValueOnce({
        boostId: "b1",
        hours: 10,
        amount: 30,
        currency: "EUR",
        invoice: null,
        subscription: null,
      })
    const user = userEvent.setup()
    const { findByTestId } = renderPanel()

    await user.click(await findByTestId("boost-buy"))
    // The card setup mounted → its onSuccess was captured.
    await waitFor(() => expect(pmHooks.onSuccess).toBeTypeOf("function"))

    await act(async () => {
      pmHooks.onSuccess?.()
    })
    await findByTestId("boost-done")

    expect(billing.purchaseBoost).toHaveBeenCalledTimes(2)
    // MUST BITE: a fresh reqId on retry would risk a double-charge.
    expect(billing.purchaseBoost.mock.calls[0][1]).toBe(billing.purchaseBoost.mock.calls[1][1])
  })

  it("on a transport error (no code) keeps the SAME reqId for a manual retry (C3)", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: null },
      paymentMethod: { brand: "visa", last4: "4242" },
      boostPricing: { hourPrice: 3, currency: "EUR" },
    })
    // A lost-response transport error carries NO `.code` (unlike a backend decline).
    billing.purchaseBoost
      .mockRejectedValueOnce(new Error("WsTransport: request timeout — billing"))
      .mockResolvedValueOnce({
        boostId: "b1",
        hours: 10,
        amount: 30,
        currency: "EUR",
        invoice: null,
        subscription: null,
      })
    const user = userEvent.setup()
    const { findByTestId } = renderPanel()

    await user.click(await findByTestId("boost-buy"))
    await waitFor(() => expect(billing.purchaseBoost).toHaveBeenCalledTimes(1))
    // Error surfaced (no card setup). The user retries manually.
    await user.click(await findByTestId("boost-buy"))
    await findByTestId("boost-done")

    expect(billing.purchaseBoost).toHaveBeenCalledTimes(2)
    // MUST BITE: without `if (code)`, a transport error nulls the reqId → the retry
    // sends a fresh purchaseId → double charge if the first charge actually landed.
    expect(billing.purchaseBoost.mock.calls[0][1]).toBe(billing.purchaseBoost.mock.calls[1][1])
  })

  it("on a coded decline gets a FRESH reqId for the retry (C3)", async () => {
    billing.getSubscription.mockResolvedValue({
      subscription: { teamId: null },
      paymentMethod: { brand: "visa", last4: "4242" },
      boostPricing: { hourPrice: 3, currency: "EUR" },
    })
    billing.purchaseBoost
      .mockRejectedValueOnce(Object.assign(new Error("declined"), { code: "PAYMENT_FAILED" }))
      .mockResolvedValueOnce({
        boostId: "b1",
        hours: 10,
        amount: 30,
        currency: "EUR",
        invoice: null,
        subscription: null,
      })
    const user = userEvent.setup()
    const { findByTestId } = renderPanel()

    await user.click(await findByTestId("boost-buy"))
    await waitFor(() => expect(billing.purchaseBoost).toHaveBeenCalledTimes(1))
    await user.click(await findByTestId("boost-buy"))
    await findByTestId("boost-done")

    expect(billing.purchaseBoost).toHaveBeenCalledTimes(2)
    // A coded decline means no charge happened → a retry is a brand-new attempt.
    expect(billing.purchaseBoost.mock.calls[0][1]).not.toBe(billing.purchaseBoost.mock.calls[1][1])
  })
})

describe("BoostPanel — load failure", () => {
  it("shows the load-error state when get-subscription fails", async () => {
    billing.getSubscription.mockRejectedValue(new Error("boom"))
    const { findByTestId } = renderPanel()
    await findByTestId("boost-load-error")
  })
})
