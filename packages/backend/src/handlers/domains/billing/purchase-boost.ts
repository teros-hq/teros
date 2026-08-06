/**
 * billing.purchase-boost — the user BUYS extra agent-hours for the current
 * period (TER-596 I1). The self-serve counterpart of the admin-granted boost
 * (resolve-access-request): instead of asking an admin, the user pays for the
 * hours directly through the payment method they vaulted via Stripe.
 *
 * Idempotency (anti double-charge) is the whole point here — money moves:
 *   - The client sends a `reqId` idempotency token, ONE per payment attempt.
 *     A network retry of the same attempt reuses the token; a fresh attempt
 *     (e.g. after a decline) uses a new token.
 *   - `purchaseId = boost-purchase:<userId>:<reqId>` ties together: the Stripe
 *     invoice idempotency keys (so Stripe never double-charges a replay), the
 *     persisted billing_invoices `_id`, and the billing_hour_boost `_id`. The
 *     boost's PRIMARY KEY is the idempotency guard — a re-submit hits a duplicate
 *     `_id` and resolves to the existing boost, never minting a second one.
 *
 * Order is charge-BEFORE-grant: we never hand out hours that weren't paid for.
 * A crash between the Stripe charge and the boost insert self-heals on retry —
 * the same purchaseId replays the (already-paid) Stripe invoice and then inserts
 * the boost. The invoice is written `paid`, which keeps the charge-cron (it only
 * scans pending/overdue) from ever touching it — a boost purchase is one-shot,
 * never dunned.
 *
 * Returns DATA (ids + numbers + resolved subscription view), never UI strings.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import {
  type BillingHourBoost,
  type BillingInvoice,
  type BillingSubscription,
  getActiveSubscription,
  getBillingHourBoostsCollection,
  getBillingInvoicesCollection,
  getBillingPlansCollection,
  getEffectiveLimit,
  insertHourBoost,
} from "../../../models/billing.js"
import { chargeOneOffInvoice } from "../../../services/billing-one-off-charge.js"
import type { StripePaymentService } from "../../../services/stripe-payment-service.js"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { shapeSubscriptionView } from "./_shared.js"

interface PurchaseBoostData {
  hours?: unknown
  /** Idempotency token, one per payment attempt (e.g. a client-side UUID). */
  reqId?: unknown
}

export interface BoostPurchaseConfig {
  /** €/hour; null disables purchases (PURCHASE_DISABLED). */
  boostHourPrice: number | null
  /** ISO 4217 currency for the charge. */
  boostCurrency: string
}

const MAX_BOOST_HOURS = 10000
const MAX_REQ_ID_LEN = 128
/** Conservative token charset so the derived purchaseId stays a clean _id. */
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function buildResponse(
  db: Db,
  active: BillingSubscription,
  boost: BillingHourBoost,
  invoice: BillingInvoice | null,
  fallbackPrice: number,
  fallbackCurrency: string,
) {
  return {
    boostId: boost._id,
    hours: boost.hours,
    amount: invoice?.amount ?? round2(boost.hours * fallbackPrice),
    currency: invoice?.currency ?? fallbackCurrency,
    invoice: invoice
      ? {
          number: invoice.invoiceNumber ?? null,
          hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
          invoicePdfUrl: invoice.invoicePdfUrl ?? null,
        }
      : null,
    // Re-shaped from the sub: getActiveBoostHours now sums the just-granted boost,
    // so agentHoursLimit/boostHours reflect the purchase immediately.
    subscription: await shapeSubscriptionView(db, active),
  }
}

export function createPurchaseBoostHandler(
  db: Db,
  stripe: StripePaymentService | null,
  cfg: BoostPurchaseConfig,
) {
  return async function purchaseBoost(ctx: WsHandlerContext, rawData: unknown) {
    if (!stripe || !stripe.isEnabled()) {
      throw new HandlerError(
        "PURCHASE_UNAVAILABLE",
        "Boost purchases are not available on this server.",
      )
    }
    const price = cfg.boostHourPrice
    if (price === null || !(price > 0)) {
      throw new HandlerError("PURCHASE_DISABLED", "Boost purchases are not enabled.")
    }

    const data = (rawData ?? {}) as PurchaseBoostData
    const hours = data.hours
    if (
      typeof hours !== "number" ||
      !Number.isFinite(hours) ||
      !Number.isInteger(hours) ||
      hours <= 0 ||
      hours > MAX_BOOST_HOURS
    ) {
      throw new HandlerError("INVALID_INPUT", `hours must be an integer in [1, ${MAX_BOOST_HOURS}]`)
    }
    if (typeof data.reqId !== "string" || !REQ_ID_RE.test(data.reqId)) {
      throw new HandlerError(
        "INVALID_INPUT",
        `reqId (idempotency token) is required: 1-${MAX_REQ_ID_LEN} chars of [A-Za-z0-9_-]`,
      )
    }
    const reqId = data.reqId
    const purchaseId = `boost-purchase:${ctx.userId}:${reqId}`

    const active = await getActiveSubscription(db, ctx.userId)
    if (!active) {
      throw new HandlerError("NO_SUBSCRIPTION", "No active subscription to add hours to")
    }

    // A boost only raises the effective limit on a metered Teros plan (the gate
    // and shapeSubscriptionView short-circuit boosts otherwise). Refuse to charge
    // for hours that would add nothing.
    const plan = await getBillingPlansCollection(db).findOne({ _id: active.planId })
    if (!plan?.features.terosModel || getEffectiveLimit(active, plan) <= 0) {
      throw new HandlerError(
        "PURCHASE_NOT_APPLICABLE",
        "Your plan does not meter agent-hours; a boost would add nothing.",
      )
    }

    const boostsCol = getBillingHourBoostsCollection(db)
    const invoicesCol = getBillingInvoicesCollection(db)

    // Idempotent short-circuit: this exact purchase already completed — return it
    // without touching Stripe again.
    const existing = await boostsCol.findOne({ _id: purchaseId })
    if (existing) {
      const invoice = await invoicesCol.findOne({ _id: purchaseId })
      return buildResponse(db, active, existing, invoice, price, cfg.boostCurrency)
    }

    const amount = round2(hours * price)
    const currency = cfg.boostCurrency

    // Charge BEFORE granting, via the shared one-off primitive (TER-619): it gates
    // on a vaulted card (NO_PAYMENT_METHOD), charges immediately via Stripe
    // Invoices with purchaseId-derived idempotency keys (a replay reuses the same
    // invoice, never double-charges — even past Stripe's ~24h key expiry, since it
    // rereads any invoice id a crashed prior attempt persisted), and writes the
    // paid invoice (kind:'boost', out of the partial period index). The boost is
    // granted only on success.
    const charge = await chargeOneOffInvoice(db, stripe, {
      userId: ctx.userId,
      invoiceId: purchaseId,
      subscriptionId: active._id,
      amount,
      currency,
      description: `Agent-hours boost (${hours}h)`,
      kind: "boost",
      periodStart: active.currentPeriodStart,
      periodEnd: active.currentPeriodEnd,
      notes: `Boost purchase: ${hours}h`,
    })
    if (charge.status !== "paid") {
      const issue = charge.issue
      throw new HandlerError(
        issue?.code ?? "PAYMENT_FAILED",
        issue?.message ?? "The payment could not be completed.",
      )
    }

    const now = new Date()
    // Grant the boost (idempotent by PK = purchaseId). A concurrent submit that
    // already inserted it hits the duplicate-key path and we read theirs back.
    const { boost: granted } = await insertHourBoost(db, {
      _id: purchaseId,
      userId: ctx.userId,
      subscriptionId: active._id,
      hours,
      periodStart: active.currentPeriodStart,
      periodEnd: active.currentPeriodEnd,
      grantedBy: ctx.userId,
      accessRequestId: null,
      source: "purchase",
      note: null,
      createdAt: now,
    })

    const invoice = await invoicesCol.findOne({ _id: purchaseId })
    return buildResponse(db, active, granted, invoice, price, currency)
  }
}
