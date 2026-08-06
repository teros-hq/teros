/**
 * billing.preview-plan-change — what WOULD happen if the caller switched to
 * `planId`, computed read-only BEFORE they confirm. Lets the profile show the
 * real prorated charge instead of generic copy.
 *
 * Honest by construction: it reuses the SAME upgrade/downgrade rule
 * (newPrice < oldPrice → downgrade) and the SAME proration formula
 * (computeProrationUpgradeCharge) that billing.change-plan applies, so the
 * preview can never diverge from what is actually charged.
 *
 *   - upgrade / lateral → applied immediately; prorationAmount = the difference
 *     prorated over the remaining period (charged via Stripe if enabled).
 *   - downgrade → deferred to currentPeriodEnd; prorationAmount = 0 (the current
 *     period is already paid).
 *
 * Returns DATA (ids + resolved names + amounts) — the frontend composes copy.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import {
  computeProrationUpgradeCharge,
  getActiveSubscription,
  getBillingPlansCollection,
  getEffectivePrice,
} from '../../../models/billing.js'

interface PreviewData {
  planId?: string
}

export function createPreviewPlanChangeHandler(db: Db) {
  return async function previewPlanChange(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as PreviewData

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

    const activePlan = await plansCol.findOne({ _id: active.planId })
    const oldPrice = getEffectivePrice(active, activePlan ?? { price: 0 })
    const newPrice = newPlan.price
    const now = new Date()

    const shared = {
      currency: newPlan.currency,
      newPrice,
      currentPlanName: activePlan?.displayName ?? active.planId,
      newPlanName: newPlan.displayName,
    }

    // Same rule as applyPlanChange: strictly-cheaper is a deferred downgrade.
    if (newPrice < oldPrice) {
      return {
        ...shared,
        kind: 'downgrade' as const,
        prorationAmount: 0,
        effectiveDate: active.currentPeriodEnd.toISOString(),
      }
    }

    return {
      ...shared,
      kind: 'upgrade' as const,
      // Same formula billing.change-plan charges → preview never lies.
      prorationAmount: activePlan
        ? computeProrationUpgradeCharge(active, activePlan, newPrice, now)
        : 0,
      effectiveDate: now.toISOString(),
    }
  }
}
