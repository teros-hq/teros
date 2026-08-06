/**
 * PaymentMethodSetup (TER-596 I3) — the assertions that bite:
 *   - happy path vaults the card then stores it as default in ORDER:
 *     confirmSetup → set-payment-method (EXACT pm id) → onSuccess,
 *   - a confirmSetup error STOPS the chain: no set-payment-method, no onSuccess,
 *     and the error surfaces (no false success) — even if Stripe hands back a pm,
 *   - a set-payment-method failure also blocks onSuccess and surfaces,
 *   - when the SetupIntent can't be minted (no publishable key) it shows the
 *     init error and never mounts the card form.
 *
 *   cd packages/app && npx vitest run src/components/billing/PaymentMethodSetup.render.test.tsx
 */
import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

const stripeH = vi.hoisted(() => ({ confirmSetup: vi.fn() }))
const billingH = vi.hoisted(() => ({
  createSetupIntent: vi.fn(),
  setPaymentMethod: vi.fn(),
}))

vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => ({})) }))
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => children,
  PaymentElement: () => null,
  useStripe: () => ({ confirmSetup: stripeH.confirmSetup }),
  useElements: () => ({}),
}))
// Faithful to the real boundary: getTerosClient returns a STABLE singleton.
vi.mock("../../services/terosClientSingleton", () => {
  const client = {
    billing: {
      createSetupIntent: billingH.createSetupIntent,
      setPaymentMethod: billingH.setPaymentMethod,
    },
  }
  return { getTerosClient: () => client }
})

import { PaymentMethodSetup } from "./PaymentMethodSetup"

function renderSetup() {
  const onSuccess = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <PaymentMethodSetup onSuccess={onSuccess} onCancel={onCancel} />
    </TamaguiProvider>,
  )
  return { ...utils, onSuccess, onCancel }
}

beforeEach(() => {
  billingH.createSetupIntent.mockReset().mockResolvedValue({
    setupIntentId: "seti_1",
    clientSecret: "seti_1_secret",
    publishableKey: "pk_test_x",
  })
  billingH.setPaymentMethod
    .mockReset()
    .mockResolvedValue({ ok: true, defaultPaymentMethodId: "pm_9" })
  stripeH.confirmSetup.mockReset()
})

describe("PaymentMethodSetup", () => {
  it("vaults then stores as default in order on the happy path", async () => {
    stripeH.confirmSetup.mockResolvedValue({
      setupIntent: { payment_method: "pm_9", status: "succeeded" },
    })
    const { getByTestId, onSuccess } = renderSetup()

    await waitFor(() => expect(getByTestId("payment-element")).toBeTruthy())
    await userEvent.click(getByTestId("payment-method-save"))

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
    expect(stripeH.confirmSetup).toHaveBeenCalledTimes(1)
    expect(billingH.setPaymentMethod).toHaveBeenCalledWith("pm_9")
  })

  it("a confirmSetup error stops the chain — no vault, no success", async () => {
    stripeH.confirmSetup.mockResolvedValue({
      error: { message: "Your card was declined." },
      setupIntent: { payment_method: "pm_must_not_use", status: "requires_payment_method" },
    })
    const { getByTestId, onSuccess } = renderSetup()

    await waitFor(() => expect(getByTestId("payment-element")).toBeTruthy())
    await userEvent.click(getByTestId("payment-method-save"))

    await waitFor(() => expect(getByTestId("payment-method-error")).toBeTruthy())
    expect(billingH.setPaymentMethod).not.toHaveBeenCalled()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("a set-payment-method failure blocks success and surfaces the error", async () => {
    stripeH.confirmSetup.mockResolvedValue({
      setupIntent: { payment_method: "pm_9", status: "succeeded" },
    })
    billingH.setPaymentMethod.mockRejectedValue(new Error("vault unavailable"))
    const { getByTestId, onSuccess } = renderSetup()

    await waitFor(() => expect(getByTestId("payment-element")).toBeTruthy())
    await userEvent.click(getByTestId("payment-method-save"))

    await waitFor(() => expect(getByTestId("payment-method-error")).toBeTruthy())
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("shows the init error and never mounts the form when Stripe is unavailable", async () => {
    billingH.createSetupIntent.mockResolvedValue({
      setupIntentId: "seti_1",
      clientSecret: "seti_1_secret",
      publishableKey: null,
    })
    const { getByTestId, queryByTestId } = renderSetup()

    await waitFor(() => expect(getByTestId("payment-method-init-error")).toBeTruthy())
    expect(queryByTestId("payment-element")).toBeNull()
  })
})
