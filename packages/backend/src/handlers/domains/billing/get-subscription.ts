/**
 * billing.get-subscription — the caller's OWN active subscription, for the
 * profile "Plan" section (active plan, hours used/included, renewal date,
 * pending downgrade, cancellation) + the default payment method on file
 * (brand/last4/exp) so the UI can show "Visa ···· 4242" instead of a blind
 * "add a card" button.
 *
 * Returns subscription:null when the user has no active subscription (the
 * frontend shows the empty / "choose a plan" state). paymentMethod is null when
 * there is no vaulted card, Stripe is disabled, or the retrieve fails.
 *
 * Returns DATA only — the frontend composes the copy.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { getActiveSubscription, getBillingPlansCollection, getEffectiveLimit } from '../../../models/billing.js'
import type { StripePaymentService } from '../../../services/stripe-payment-service.js'
import type { BoostPurchaseConfig } from './purchase-boost.js'
import { shapeSubscriptionView } from './_shared.js'

/**
 * Self-serve boost pricing the user would pay per hour, or null when buying a
 * boost is not available (Stripe disabled or BILLING_BOOST_HOUR_PRICE unset).
 * This is the GLOBAL half of the purchase-boost gate; the per-plan half
 * (PURCHASE_NOT_APPLICABLE on a non-metered plan) is applied in the handler.
 */
function resolveBoostPricing(
  stripe: StripePaymentService | null,
  cfg: BoostPurchaseConfig,
): { hourPrice: number; currency: string } | null {
  if (!stripe) return null // PURCHASE_UNAVAILABLE — no payment gateway
  if (cfg.boostHourPrice === null || !(cfg.boostHourPrice > 0)) return null // PURCHASE_DISABLED
  return { hourPrice: cfg.boostHourPrice, currency: cfg.boostCurrency }
}

export function createGetSubscriptionHandler(
  db: Db,
  stripe: StripePaymentService | null,
  boostCfg: BoostPurchaseConfig,
) {
  const baseBoostPricing = resolveBoostPricing(stripe, boostCfg)
  return async function getSubscription(ctx: WsHandlerContext, _rawData: unknown) {
    const sub = await getActiveSubscription(db, ctx.userId)
    // No active sub → carry the global pricing (the no-sub state may still offer a
    // plan/boost entry point); there is no plan to apply the metered gate to.
    if (!sub) return { subscription: null, paymentMethod: null, boostPricing: baseBoostPricing }

    const [view, paymentMethod, plan] = await Promise.all([
      shapeSubscriptionView(db, sub),
      stripe ? stripe.getDefaultCard(ctx.userId) : Promise.resolve(null),
      getBillingPlansCollection(db).findOne({ _id: sub.planId }),
    ])
    // Per-plan half of the gate: a boost only adds hours on a metered Teros plan,
    // so don't advertise a price the backend would reject with
    // PURCHASE_NOT_APPLICABLE (mirrors billing.purchase-boost exactly).
    const metered = !!plan?.features.terosModel && getEffectiveLimit(sub, plan) > 0
    return { subscription: view, paymentMethod, boostPricing: metered ? baseBoostPricing : null }
  }
}
