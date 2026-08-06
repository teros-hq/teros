/**
 * BillingApi — Typed client for the user-facing billing domain (billing.*).
 *
 * Mirrors the backend handlers in packages/backend/src/handlers/domains/billing:
 * the public plan catalogue, the caller's own subscription, self-serve plan
 * changes, and the Stripe payment-method vaulting used by the onboarding
 * checkout (TER-596 I2). Returns DATA only — the components compose the copy.
 */

import type { Transport } from "./transport/types"

// ============================================================================
// Shared types (mirror the backend response shapes)
// ============================================================================

/** A row from billing.list-plans (the public catalogue). */
export interface BillingPlanView {
  planId: string
  name: string
  displayName: string
  description: string
  /** Monthly list price in the smallest currency unit's major form (e.g. EUR). */
  price: number
  /** Price once the BETA waiver ends, or null when unknown. */
  postBetaPrice: number | null
  currency: string
  /** Included agent-hours per period (0 = unmetered / contact-sales). */
  agentHoursLimit: number
  /** Whether the plan includes the bundled Teros model (metered hours). */
  terosModel: boolean
  highlights: string[]
  popular: boolean
  contactSales: boolean
}

/** The caller's own active subscription (billing.get-subscription / change-plan). */
export interface SubscriptionView {
  planId: string
  planName: string
  price: number
  currency: string
  /** Effective hour limit for the period, including active boosts. */
  agentHoursLimit: number
  agentHoursUsed: number
  boostHours: number
  terosModel: boolean
  status: "active" | "cancelled" | "past_due" | "incomplete"
  currentPeriodStart: string
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  scheduledPlanChange: { planId: string; planName: string; scheduledAt: string } | null
  teamId: string | null
}

/** Result of starting payment-method vaulting (billing.create-setup-intent). */
export interface SetupIntentView {
  setupIntentId: string
  clientSecret: string
  /** Publishable key for Stripe.js; null when Stripe is not configured. */
  publishableKey: string | null
}

/** The caller's default vaulted card (billing.get-subscription). */
export interface PaymentMethodView {
  /** Card network, lowercase: 'visa' | 'mastercard' | 'amex' | … */
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

/**
 * Self-serve boost pricing (billing.get-subscription). null when buying a boost
 * is unavailable (Stripe off) or disabled (price unset) — the buy modal then
 * shows an "unavailable" state instead of a purchase form.
 */
export interface BoostPricingView {
  /** Price per extra agent-hour, in major currency units (e.g. EUR). */
  hourPrice: number
  currency: string
}

/** Result of billing.purchase-boost (the bought boost + its paid invoice). */
export interface BoostPurchaseResult {
  boostId: string
  hours: number
  /** Total charged, in major currency units. */
  amount: number
  currency: string
  invoice: { number: string | null; hostedInvoiceUrl: string | null; invoicePdfUrl: string | null } | null
  subscription: SubscriptionView | null
}

/** Result of billing.request-access (the created pending request). */
export interface AccessRequestResult {
  request: {
    _id: string
    type: "boost" | "upgrade"
    requestedHours: number | null
    requestedPlanId: string | null
    reason: string | null
    status: "pending" | "approved" | "denied"
    createdAt: string
  }
}

/** Read-only quote of a plan change (billing.preview-plan-change). */
export interface PlanChangePreview {
  /** upgrade/lateral applies now; downgrade is deferred to the period end. */
  kind: "upgrade" | "downgrade"
  /** Prorated charge for an upgrade (0 for a downgrade). Same units as price. */
  prorationAmount: number
  currency: string
  newPrice: number
  currentPlanName: string
  newPlanName: string
  /** ISO: now for an upgrade, currentPeriodEnd for a downgrade. */
  effectiveDate: string
}

/** A row from billing.get-invoices (the caller's own invoice history). */
export interface InvoiceView {
  id: string
  /** Stripe's legal sequential number (e.g. "TEROS-0001"), or null if uncharged. */
  invoiceNumber: string | null
  amount: number
  currency: string
  status: "pending" | "invoiced" | "paid" | "waived" | "overdue" | "uncollectible"
  /** Billed period (ISO strings). */
  periodStart: string
  periodEnd: string
  /** Stripe-hosted invoice page (pay + view); null until charged via Stripe. */
  hostedInvoiceUrl: string | null
  /** Stripe-hosted PDF of the finalized invoice; null until charged via Stripe. */
  invoicePdfUrl: string | null
  createdAt: string
}

// ============================================================================
// BillingApi
// ============================================================================

export class BillingApi {
  constructor(private readonly transport: Transport) {}

  /** Public plan catalogue, ordered for display (contact-sales last). */
  listPlans(): Promise<{ plans: BillingPlanView[] }> {
    return this.transport.request("billing.list-plans", {})
  }

  /**
   * The caller's own active subscription (or null) + the default card on file
   * (or null when none is vaulted / Stripe is off).
   */
  getSubscription(): Promise<{
    subscription: SubscriptionView | null
    paymentMethod: PaymentMethodView | null
    /** Per-hour boost price, or null when buying a boost is unavailable/disabled. */
    boostPricing: BoostPricingView | null
  }> {
    return this.transport.request("billing.get-subscription", {})
  }

  /** Quote a plan change (upgrade prorated charge / deferred downgrade) before commit. */
  previewPlanChange(planId: string): Promise<PlanChangePreview> {
    return this.transport.request("billing.preview-plan-change", { planId })
  }

  /**
   * Change the caller's OWN plan. A PAID upgrade charges the prorated difference
   * to the vaulted card IMMEDIATELY and is granted only if that charge succeeds
   * (TER-619); downgrades and lateral/free changes apply without a charge.
   *
   * `reqId` is an idempotency token: ONE per payment attempt — required for a paid
   * upgrade so a network retry never double-charges; mint a fresh one after a
   * decline. `invoice` is present only when a charge was made.
   */
  changePlan(
    planId: string,
    reqId?: string,
  ): Promise<{
    kind: "upgraded" | "downgrade_scheduled"
    subscription: SubscriptionView | null
    invoice: {
      number: string | null
      hostedInvoiceUrl: string | null
      invoicePdfUrl: string | null
      amount: number
      currency: string
    } | null
  }> {
    return this.transport.request(
      "billing.change-plan",
      reqId ? { planId, reqId } : { planId },
    )
  }

  /** The caller's own invoice history, most-recent first (capped at `limit`). */
  getInvoices(limit?: number): Promise<{ invoices: InvoiceView[] }> {
    return this.transport.request("billing.get-invoices", limit === undefined ? {} : { limit })
  }

  /** Start Stripe payment-method vaulting (SetupIntent) for the caller. */
  createSetupIntent(): Promise<SetupIntentView> {
    return this.transport.request("billing.create-setup-intent", {})
  }

  /** Store a vaulted payment method as the caller's default. */
  setPaymentMethod(
    paymentMethodId: string,
  ): Promise<{ ok: true; defaultPaymentMethodId: string | null }> {
    return this.transport.request("billing.set-payment-method", { paymentMethodId })
  }

  /**
   * Buy `hours` extra agent-hours for the current period, charging the vaulted
   * card. `reqId` is an idempotency token: ONE per payment attempt — reuse it to
   * retry the same attempt (no double-charge), mint a fresh one after a decline.
   */
  purchaseBoost(hours: number, reqId: string): Promise<BoostPurchaseResult> {
    return this.transport.request("billing.purchase-boost", { hours, reqId })
  }

  /**
   * Ask an admin for a boost (extra hours on this period). Used by team members,
   * who request instead of buying. `reason` is omitted when empty.
   */
  requestAccess(input: {
    requestedHours: number
    reason?: string
  }): Promise<AccessRequestResult> {
    return this.transport.request("billing.request-access", {
      type: "boost",
      requestedHours: input.requestedHours,
      ...(input.reason ? { reason: input.reason } : {}),
    })
  }
}
