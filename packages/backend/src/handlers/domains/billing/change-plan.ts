/**
 * billing.change-plan — the user changes their OWN plan from the profile.
 *
 * Upgrade vs downgrade is decided by the SAME rule the admin panel and the
 * read-only preview use (newPrice < oldPrice → downgrade), so they can never
 * diverge:
 *   - downgrade → deferred to the period end (keeps the paid tier until the cut);
 *   - lateral / free upgrade (proration €0) → applied immediately, no charge;
 *   - PAID upgrade (proration > 0) → charge-BEFORE-grant (TER-619): the prorated
 *     difference is charged to the vaulted card IMMEDIATELY via Stripe Invoices,
 *     and the plan is granted only if that charge succeeds. No card or a decline
 *     → the upgrade is refused and nothing changes.
 *
 * This closes the monetization hole where a self-serve upgrade granted a paid
 * tier for free: the old path granted first and "charged" via a best-effort
 * customer-balance transaction that silently no-op'd. It now mirrors
 * billing.purchase-boost via the shared chargeOneOffInvoice primitive.
 *
 * The admin paths (admin.update-billing-subscription, admin.resolve-access-request)
 * deliberately do NOT gate — an admin grants a tier as a billing decision.
 *
 * Self-serve only covers the public, non-enterprise plans; Enterprise is
 * contact-sales. Returns the resulting subscription view + the change kind (+ the
 * paid invoice, when one was charged) so the frontend composes the copy.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import {
  computeProrationUpgradeCharge,
  getActiveSubscription,
  getBillingPlansCollection,
} from '../../../models/billing.js'
import { chargeOneOffInvoice } from '../../../services/billing-one-off-charge.js'
import { applyPlanChange } from '../../../services/billing-subscription-ops.js'
import type { StripePaymentService } from '../../../services/stripe-payment-service.js'
import { shapeSubscriptionView } from './_shared.js'

interface ChangePlanData {
  planId?: string
  /**
   * Idempotency token, one per payment attempt (e.g. a client-side UUID).
   * Required only when the change is a PAID upgrade (proration > 0) on a
   * Stripe-enabled server — that is the only branch that moves money.
   */
  reqId?: unknown
}

const MAX_REQ_ID_LEN = 128
/** Conservative token charset so the derived invoice _id stays a clean _id. */
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export function createChangePlanHandler(db: Db, stripe: StripePaymentService | null) {
  return async function changePlan(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as ChangePlanData

    if (typeof data.planId !== 'string' || data.planId.trim() === '') {
      throw new HandlerError('INVALID_INPUT', 'planId is required')
    }
    const planId = data.planId.trim()

    const plansCol = getBillingPlansCollection(db)
    const newPlan = await plansCol.findOne({ _id: planId })
    if (!newPlan || !newPlan.isPublic) {
      throw new HandlerError('INVALID_PLAN', `Plan ${planId} not found`)
    }
    if (newPlan.contactSales) {
      throw new HandlerError(
        'CONTACT_SALES',
        'This plan is not self-serve — contact sales to switch to it.',
      )
    }

    const active = await getActiveSubscription(db, ctx.userId)
    if (!active) {
      throw new HandlerError('NO_SUBSCRIPTION', 'No active subscription to change')
    }
    // A no-op change to the same plan is rejected (a pending downgrade back to the
    // current plan would be a confusing no-op too — the user cancels instead).
    if (active.planId === planId && !active.scheduledPlanChange) {
      throw new HandlerError('SAME_PLAN', 'You are already on this plan')
    }

    const now = new Date()

    // Proration the SAME way preview-plan-change + applyPlanChange compute it, so
    // the gate decision can never disagree with what the user was quoted.
    const activePlan = await plansCol.findOne({ _id: active.planId })
    const charge = activePlan
      ? computeProrationUpgradeCharge(active, activePlan, newPlan.price, now)
      : 0

    // PAID upgrade on a Stripe-enabled server → charge BEFORE granting. A
    // downgrade, a lateral move, or a €0-proration upgrade (charge === 0) skips
    // this entirely and is applied for free, as before. When Stripe is not
    // configured the server runs manual billing and the gate cannot apply.
    let paidInvoice: Awaited<ReturnType<typeof chargeOneOffInvoice>> | null = null
    if (charge > 0 && stripe?.isEnabled()) {
      if (typeof data.reqId !== 'string' || !REQ_ID_RE.test(data.reqId)) {
        throw new HandlerError(
          'INVALID_INPUT',
          `reqId (idempotency token) is required for a paid upgrade: 1-${MAX_REQ_ID_LEN} chars of [A-Za-z0-9_-]`,
        )
      }
      paidInvoice = await chargeOneOffInvoice(db, stripe, {
        userId: ctx.userId,
        // The idempotency anchor binds the charge to (user, TARGET plan, attempt).
        // Without planId a user could replay a paid reqId for a DIFFERENT, pricier
        // plan: chargeOneOffInvoice would reread the prior invoice, reuse its Stripe
        // id, and payInvoice would return the cached (already-paid) result — granting
        // the pricier tier for the cheaper proration. planId in the key makes the
        // cross-plan replay mint a fresh invoice that actually charges.
        invoiceId: `plan-change:${ctx.userId}:${planId}:${data.reqId}`,
        subscriptionId: active._id,
        amount: charge,
        currency: newPlan.currency,
        description: `Plan upgrade proration → ${newPlan.displayName}`,
        kind: 'proration',
        periodStart: active.currentPeriodStart,
        periodEnd: active.currentPeriodEnd,
        notes: `Upgrade ${active.planId} → ${planId} (prorated)`,
      })
      if (paidInvoice.status !== 'paid') {
        const issue = paidInvoice.issue
        throw new HandlerError(
          issue?.code ?? 'PAYMENT_FAILED',
          issue?.message ?? 'The payment could not be completed.',
        )
      }
    }

    // Grant the change. Pass NO stripe: the immediate proration was already
    // charged above, so applyPlanChange must NOT also run its internal best-effort
    // balance-transaction charge (that would double-bill the difference).
    const { kind } = await applyPlanChange(db, active, planId, now)

    // Re-read: an upgrade replaced the active sub; a downgrade edited it in place.
    const current = await getActiveSubscription(db, ctx.userId)
    return {
      kind, // 'upgraded' | 'downgrade_scheduled'
      subscription: current ? await shapeSubscriptionView(db, current) : null,
      invoice:
        paidInvoice?.status === 'paid'
          ? {
              number: paidInvoice.invoice.invoiceNumber ?? null,
              hostedInvoiceUrl: paidInvoice.invoice.hostedInvoiceUrl ?? null,
              invoicePdfUrl: paidInvoice.invoice.invoicePdfUrl ?? null,
              amount: paidInvoice.invoice.amount,
              currency: paidInvoice.invoice.currency,
            }
          : null,
    }
  }
}
