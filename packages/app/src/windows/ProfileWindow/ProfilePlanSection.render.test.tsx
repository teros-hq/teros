/**
 * ProfilePlanSection (TER-596 I3, redesign) — the assertions that bite:
 *   - loads the hero (plan + usage bar), the comparable pricing cards, and the
 *     card on file (Visa ···· 4242);
 *   - picking a plan card calls preview-plan-change with the EXACT planId, shows
 *     the quote, and confirming calls change-plan with the EXACT planId; the
 *     toast reflects the backend kind (upgrade = title only; downgrade = +detail);
 *   - a preview failure surfaces an error toast and drops the confirm;
 *   - a change-plan failure surfaces an error toast and keeps the plan;
 *   - no card → "add card" affordance, no card display;
 *   - invoices render with hosted-page + PDF links; empty shows the notice;
 *   - the payment affordance reveals the Stripe form, toasts + refetches on success;
 *   - a load failure shows the error + Retry recovers.
 *
 *   cd packages/app && npx vitest run src/windows/ProfileWindow/ProfilePlanSection.render.test.tsx
 */
import { render, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"
import type {
  BillingPlanView,
  InvoiceView,
  PaymentMethodView,
  SubscriptionView,
} from "../../services/BillingApi"

const billingH = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  listPlans: vi.fn(),
  getInvoices: vi.fn(),
  previewPlanChange: vi.fn(),
  changePlan: vi.fn(),
}))
const toastH = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
}))

vi.mock("@tamagui/lucide-icons", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const Stub = () => null
  return {
    ...actual,
    ArrowLeft: Stub,
    Check: Stub,
    CheckCircle: Stub,
    CreditCard: Stub,
    ExternalLink: Stub,
    FileText: Stub,
    Infinity: Stub,
    Receipt: Stub,
  }
})
vi.mock("../../components/Toast", () => ({ useToast: () => toastH }))
vi.mock("../../components/ui", () => ({ AppSpinner: () => null }))
vi.mock("../../components/billing/PaymentMethodSetup", async () => {
  const React = await import("react")
  return {
    PaymentMethodSetup: (props: { onSuccess: () => void; onCancel: () => void }) =>
      React.createElement("button", { "data-testid": "pm-stub", onClick: props.onSuccess }, "pm"),
  }
})
vi.mock("../../services/terosClientSingleton", () => {
  const client = { isConnected: () => true, on: () => {}, off: () => {}, billing: billingH }
  return { getTerosClient: () => client }
})

import { ProfilePlanSection } from "./ProfilePlanSection"

function plan(over: Partial<BillingPlanView>): BillingPlanView {
  return {
    planId: "plan_x",
    name: "x",
    displayName: "X",
    description: "",
    price: 0,
    postBetaPrice: null,
    currency: "EUR",
    agentHoursLimit: 0,
    terosModel: true,
    highlights: ["feature a", "feature b"],
    popular: false,
    contactSales: false,
    ...over,
  }
}
const STARTER = plan({
  planId: "plan_starter",
  displayName: "Starter",
  price: 0,
  agentHoursLimit: 10,
})
const GROWTH = plan({
  planId: "plan_growth",
  displayName: "Growth",
  price: 89,
  agentHoursLimit: 40,
  popular: true,
})
const PRO = plan({ planId: "plan_pro", displayName: "Pro", price: 179, agentHoursLimit: 80 })
const ENTERPRISE = plan({
  planId: "plan_enterprise",
  displayName: "Enterprise",
  contactSales: true,
})
const PLANS = [STARTER, GROWTH, PRO, ENTERPRISE]

const SUB: SubscriptionView = {
  planId: "plan_growth",
  planName: "Growth",
  price: 89,
  currency: "EUR",
  agentHoursLimit: 40,
  agentHoursUsed: 12,
  boostHours: 0,
  terosModel: true,
  status: "active",
  currentPeriodStart: "2026-06-01T00:00:00.000Z",
  currentPeriodEnd: "2026-07-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  scheduledPlanChange: null,
  teamId: null,
}
const CARD: PaymentMethodView = { brand: "visa", last4: "4242", expMonth: 4, expYear: 2027 }
const PAID_INVOICE: InvoiceView = {
  id: "inv_1",
  invoiceNumber: "TEROS-0001",
  amount: 89,
  currency: "EUR",
  status: "paid",
  periodStart: "2026-06-01T00:00:00.000Z",
  periodEnd: "2026-07-01T00:00:00.000Z",
  hostedInvoiceUrl: "https://stripe.test/i/inv_1",
  invoicePdfUrl: "https://stripe.test/i/inv_1.pdf",
  createdAt: "2026-06-01T00:00:00.000Z",
}

function renderSection() {
  const onBack = vi.fn()
  const utils = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <ProfilePlanSection onBack={onBack} />
    </TamaguiProvider>,
  )
  return { ...utils, onBack }
}

beforeEach(() => {
  billingH.getSubscription.mockReset().mockResolvedValue({ subscription: SUB, paymentMethod: CARD })
  billingH.listPlans.mockReset().mockResolvedValue({ plans: PLANS })
  billingH.getInvoices.mockReset().mockResolvedValue({ invoices: [] })
  billingH.previewPlanChange.mockReset().mockResolvedValue({
    kind: "upgrade",
    prorationAmount: 45,
    currency: "EUR",
    newPrice: 179,
    currentPlanName: "Growth",
    newPlanName: "Pro",
    effectiveDate: "2026-06-22T00:00:00.000Z",
  })
  billingH.changePlan.mockReset().mockResolvedValue({ kind: "upgraded", subscription: SUB })
  toastH.success.mockReset()
  toastH.error.mockReset()
})

describe("ProfilePlanSection (redesign)", () => {
  it("renders the hero, pricing cards and the card on file", async () => {
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("plan-hero")).toBeTruthy())
    expect(getByTestId("plan-hero").textContent).toContain("Growth")
    expect(getByTestId("usage-bar")).toBeTruthy()
    expect(getByTestId("pricing-card-plan_pro")).toBeTruthy()
    expect(getByTestId("current-badge-plan_growth")).toBeTruthy()
    expect(getByTestId("payment-card-display").textContent).toContain("4242")
  })

  it("shows the chrome-metallic hero (unmetered tagline) for plan_unlimited (TER-638)", async () => {
    billingH.getSubscription.mockResolvedValue({
      subscription: { ...SUB, planId: "plan_unlimited", planName: "Unlimited", agentHoursLimit: 0 },
      paymentMethod: CARD,
    })
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("plan-hero")).toBeTruthy())
    expect(getByTestId("plan-hero").textContent).toContain("Unlimited")
    // The metallic hero renders its own tagline marker (default hero never does).
    expect(getByTestId("unlimited-tagline")).toBeTruthy()
  })

  it("keeps the normal hero for a metered plan (no metallic treatment)", async () => {
    const { getByTestId, queryByTestId } = renderSection() // default mock = Growth
    await waitFor(() => expect(getByTestId("plan-hero")).toBeTruthy())
    expect(queryByTestId("unlimited-tagline")).toBeNull()
  })

  it("does NOT apply the metallic hero to Enterprise — only plan_unlimited", async () => {
    // MUST BITE: gating on `unmetered` / agentHoursLimit===0 instead of the exact
    // planId would also light up Enterprise (also 0h). Only Unlimited holders see it.
    billingH.getSubscription.mockResolvedValue({
      subscription: { ...SUB, planId: "plan_enterprise", planName: "Enterprise", agentHoursLimit: 0 },
      paymentMethod: CARD,
    })
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("plan-hero")).toBeTruthy())
    expect(queryByTestId("unlimited-tagline")).toBeNull()
  })

  it("upgrade: select → preview (exact planId) → confirm → change-plan (exact planId)", async () => {
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    await userEvent.click(getByTestId("cta-plan_pro"))
    await waitFor(() => expect(billingH.previewPlanChange).toHaveBeenCalledWith("plan_pro"))
    await waitFor(() => expect(getByTestId("change-confirm")).toBeTruthy())

    await userEvent.click(getByTestId("change-confirm-apply"))
    // Paid upgrade carries a per-attempt idempotency token (TER-619).
    await waitFor(() =>
      expect(billingH.changePlan).toHaveBeenCalledWith("plan_pro", expect.any(String)),
    )
    expect(toastH.success).toHaveBeenCalledTimes(1)
    expect(toastH.error).not.toHaveBeenCalled()
    expect(toastH.success.mock.calls[0][1]).toBeUndefined() // upgrade = title only
  })

  it("paid upgrade with NO card: shows the inline card form, blocks confirm until a card is added, then charges with a reqId (TER-619)", async () => {
    billingH.getSubscription
      .mockReset()
      .mockResolvedValueOnce({ subscription: SUB, paymentMethod: null }) // initial load: no card
      .mockResolvedValueOnce({ subscription: SUB, paymentMethod: CARD }) // after the card is vaulted
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    // Select the paid upgrade. With no card, the confirm box shows the card form,
    // NOT a confirm button — the user cannot trigger a charge the backend refuses.
    await userEvent.click(getByTestId("cta-plan_pro"))
    await waitFor(() => expect(getByTestId("change-needs-card")).toBeTruthy())
    expect(queryByTestId("change-confirm-apply")).toBeNull()
    expect(billingH.changePlan).not.toHaveBeenCalled()

    // Vault a card (pm-stub onClick = onCardAdded) → refetch returns a card →
    // the form is replaced by the confirm button.
    await userEvent.click(getByTestId("pm-stub"))
    await waitFor(() => expect(getByTestId("change-confirm-apply")).toBeTruthy())
    expect(queryByTestId("change-needs-card")).toBeNull()

    // Now confirming charges, with an idempotency token.
    await userEvent.click(getByTestId("change-confirm-apply"))
    await waitFor(() =>
      expect(billingH.changePlan).toHaveBeenCalledWith("plan_pro", expect.any(String)),
    )
  })

  it("downgrade: preview shows the deferred quote, toast carries the until-date detail", async () => {
    billingH.previewPlanChange.mockResolvedValue({
      kind: "downgrade",
      prorationAmount: 0,
      currency: "EUR",
      newPrice: 0,
      currentPlanName: "Growth",
      newPlanName: "Starter",
      effectiveDate: "2026-07-01T00:00:00.000Z",
    })
    billingH.changePlan.mockResolvedValue({
      kind: "downgrade_scheduled",
      subscription: {
        ...SUB,
        scheduledPlanChange: {
          planId: "plan_starter",
          planName: "Starter",
          scheduledAt: "2026-07-01T00:00:00.000Z",
        },
      },
    })
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_starter")).toBeTruthy())

    await userEvent.click(getByTestId("cta-plan_starter"))
    await waitFor(() => expect(billingH.previewPlanChange).toHaveBeenCalledWith("plan_starter"))
    await userEvent.click(getByTestId("change-confirm-apply"))

    // Every change attempt carries an idempotency token now (TER-634) — a
    // downgrade is free, but the backend ignores the token when it doesn't charge.
    await waitFor(() =>
      expect(billingH.changePlan).toHaveBeenCalledWith("plan_starter", expect.any(String)),
    )
    expect(toastH.success).toHaveBeenCalledTimes(1)
    expect(toastH.success.mock.calls[0][1]).toBeTruthy() // downgrade detail present
  })

  it("always attaches an idempotency reqId — even for a change the frontend sees as free (TER-634)", async () => {
    // Regression: the reqId used to be gated on the frontend's own paid-upgrade
    // prediction (preview.kind === 'upgrade' && prorationAmount > 0). A change the
    // frontend reads as free (prorationAmount 0) — or a null/stale preview at
    // confirm — POSTed with NO token, and the backend refused any upgrade it
    // recomputed as charged ("reqId is required for a paid upgrade"). Now EVERY
    // attempt carries a token; the backend decides whether to charge.
    billingH.previewPlanChange.mockResolvedValue({
      kind: "upgrade",
      prorationAmount: 0, // frontend sees a FREE upgrade → old code sent no token
      currency: "EUR",
      newPrice: 89,
      currentPlanName: "Growth",
      newPlanName: "Pro",
      effectiveDate: "2026-06-22T00:00:00.000Z",
    })
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    await userEvent.click(getByTestId("cta-plan_pro"))
    await waitFor(() => expect(getByTestId("change-confirm-apply")).toBeTruthy())
    await userEvent.click(getByTestId("change-confirm-apply"))

    // MUST BITE: re-gating reqId on isPaidUpgrade drops the token in this branch.
    await waitFor(() =>
      expect(billingH.changePlan).toHaveBeenCalledWith("plan_pro", expect.any(String)),
    )
  })

  it("discards a stale preview when the user re-selects before it resolves (M1)", async () => {
    const resolvers: Record<string, (v: any) => void> = {}
    billingH.previewPlanChange.mockReset().mockImplementation(
      (planId: string) =>
        new Promise((resolve) => {
          resolvers[planId] = resolve
        }),
    )
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    // Select Pro (A), then Starter (B) before A resolves.
    await userEvent.click(getByTestId("cta-plan_pro"))
    await userEvent.click(getByTestId("cta-plan_starter"))

    // Resolve the LATEST (Starter) first, then the stale Pro — out of order.
    resolvers.plan_starter({
      kind: "downgrade",
      prorationAmount: 0,
      currency: "EUR",
      newPrice: 0,
      currentPlanName: "Growth",
      newPlanName: "Starter",
      effectiveDate: "2026-07-01T00:00:00.000Z",
    })
    resolvers.plan_pro({
      kind: "upgrade",
      prorationAmount: 45,
      currency: "EUR",
      newPrice: 179,
      currentPlanName: "Growth",
      newPlanName: "Pro",
      effectiveDate: "2026-06-22T00:00:00.000Z",
    })

    await waitFor(() => expect(getByTestId("change-confirm")).toBeTruthy())
    // The confirm BODY (not the title, which uses the pending plan name) is
    // derived from `preview`. MUST BITE: without the previewReqRef guard, Pro's
    // late response sets preview=Pro → the body shows Pro's €45 prorated charge
    // while the pending plan is the free Starter downgrade → amount ≠ what's charged.
    const body = getByTestId("change-preview-amount").textContent ?? ""
    expect(body).toContain("Starter")
    expect(body).not.toContain("45")
  })

  it("the scheduled-change pill shows the period-end date, not scheduledAt (M2)", async () => {
    billingH.getSubscription.mockResolvedValue({
      subscription: {
        ...SUB,
        currentPeriodEnd: "2026-07-01T00:00:00.000Z",
        scheduledPlanChange: {
          planId: "plan_starter",
          planName: "Starter",
          scheduledAt: "2026-06-22T00:00:00.000Z", // when it was queued (≈ now)
        },
      },
      paymentMethod: CARD,
    })
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("scheduled-change")).toBeTruthy())
    const txt = getByTestId("scheduled-change").textContent ?? ""
    // The downgrade takes effect at currentPeriodEnd (Jul 1), NOT scheduledAt
    // (Jun 22). MUST BITE: reverting to scheduledAt makes the pill show "22".
    expect(txt).toContain("Starter")
    expect(txt).not.toContain("22")
  })

  it("a preview failure surfaces an error toast and drops the confirm", async () => {
    billingH.previewPlanChange.mockRejectedValue(new Error("preview down"))
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    await userEvent.click(getByTestId("cta-plan_pro"))
    await waitFor(() => expect(toastH.error).toHaveBeenCalledTimes(1))
    expect(queryByTestId("change-confirm")).toBeNull()
    expect(billingH.changePlan).not.toHaveBeenCalled()
  })

  it("a change-plan failure surfaces an error toast and keeps the plan", async () => {
    billingH.changePlan.mockRejectedValue(new Error("CONTACT_SALES"))
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("cta-plan_pro")).toBeTruthy())

    await userEvent.click(getByTestId("cta-plan_pro"))
    await waitFor(() => expect(getByTestId("change-confirm-apply")).toBeTruthy())
    await userEvent.click(getByTestId("change-confirm-apply"))

    await waitFor(() => expect(toastH.error).toHaveBeenCalledTimes(1))
    expect(toastH.success).not.toHaveBeenCalled()
    expect(getByTestId("plan-hero").textContent).toContain("Growth")
  })

  it("no card on file → add-card affordance, no card display", async () => {
    billingH.getSubscription.mockResolvedValue({ subscription: SUB, paymentMethod: null })
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("manage-payment")).toBeTruthy())
    expect(queryByTestId("payment-card-display")).toBeNull()
  })

  it("renders invoices with hosted-page + PDF links", async () => {
    billingH.getInvoices.mockResolvedValue({ invoices: [PAID_INVOICE] })
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("invoice-inv_1")).toBeTruthy())
    expect(getByTestId("invoice-view-inv_1")).toBeTruthy()
    expect(getByTestId("invoice-pdf-inv_1")).toBeTruthy()
  })

  it("shows the empty notice when there are no invoices", async () => {
    const { getByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("no-invoices")).toBeTruthy())
  })

  it("manage payment reveals the Stripe form, toasts + refetches on success", async () => {
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("manage-payment")).toBeTruthy())

    await userEvent.click(getByTestId("manage-payment"))
    expect(getByTestId("pm-stub")).toBeTruthy()

    await userEvent.click(getByTestId("pm-stub")) // triggers onSuccess
    await waitFor(() => expect(toastH.success).toHaveBeenCalledTimes(1))
    expect(queryByTestId("pm-stub")).toBeNull()
    // getSubscription is called once on load + once to refetch the card.
    expect(billingH.getSubscription).toHaveBeenCalledTimes(2)
  })

  it("shows the load error and recovers on Retry", async () => {
    billingH.getSubscription.mockRejectedValueOnce(new Error("network down"))
    const { getByTestId, queryByTestId } = renderSection()
    await waitFor(() => expect(getByTestId("plan-load-error")).toBeTruthy())
    expect(queryByTestId("plan-hero")).toBeNull()

    await userEvent.click(getByTestId("plan-retry"))
    await waitFor(() => expect(getByTestId("plan-hero")).toBeTruthy())
    expect(queryByTestId("plan-load-error")).toBeNull()
  })
})
