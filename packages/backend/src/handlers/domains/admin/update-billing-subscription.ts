/**
 * admin.update-billing-subscription — Update a user's billing subscription (admin only)
 *
 * Supports:
 *   - change tier (planId)
 *   - edit customPrice + customPriceNote
 *   - edit customAgentHoursLimit
 *   - mark billingStatus (pending/invoiced/paid/waived)
 *   - edit billingNotes
 *   - pause/reactivate (subscription status)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import {
  addMonthsClampDay,
  getActiveSubscription,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getBillingInvoicesCollection,
  getTerosProviderConfigsCollection,
  getBillingTeamsCollection,
  STARTER_PLAN_ID,
  type BillingSubscription,
} from '../../../models/billing'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import { changeUserPlanImmediate } from '../../../services/billing-subscription-ops'

interface UpdateBillingData {
  targetUserId: string
  planId?: string
  customPrice?: number | null
  customPriceNote?: string | null
  customAgentHoursLimit?: number | null
  paymentMethod?: 'stripe' | 'manual'
  billingNotes?: string
  status?: 'active' | 'paused' | 'cancelled' | 'past_due'
  terosProviderConfigId?: string | null
  teamId?: string | null
}

/**
 * Validate a nullable numeric field at the handler boundary. JSON Schema does
 * not catch NaN/Infinity, and Number() in the client happily produces them.
 * Rejects non-finite values, values below `min`, and (when required) non-integers.
 */
function assertNullableNumber(
  value: number | null | undefined,
  field: string,
  opts: { min: number; integer?: boolean },
): void {
  if (value === undefined || value === null) return
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < opts.min ||
    (opts.integer && !Number.isInteger(value))
  ) {
    throw new HandlerError(
      'INVALID_INPUT',
      `${field} must be a finite number >= ${opts.min}${opts.integer ? ' (integer)' : ''}`,
    )
  }
}

export function createUpdateBillingSubscriptionHandler(
  userService: UserService,
  db: Db,
  stripe?: StripePaymentService | null,
) {
  return async function updateBillingSubscription(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateBillingData

    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { targetUserId } = data
    if (!targetUserId) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId is required')
    }

    // Verify target user exists
    const targetUser = await userService.getByUserId(targetUserId)
    if (!targetUser) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    // Validate numeric inputs at the boundary (DB Writes Are Contracts).
    assertNullableNumber(data.customPrice, 'customPrice', { min: 0 })
    assertNullableNumber(data.customAgentHoursLimit, 'customAgentHoursLimit', {
      min: 0,
      integer: true,
    })

    const subsCol = getBillingSubscriptionsCollection(db)
    const plansCol = getBillingPlansCollection(db)

    // The user's single active subscription (subscription history: at most one
    // 'active' per user, enforced by billing_sub_one_active).
    let active = await getActiveSubscription(db, targetUserId)

    // No active sub (new user, or fully paused/ended) — open a default Starter one.
    if (!active) {
      const starterPlan = await plansCol.findOne({ _id: STARTER_PLAN_ID })
      const bootNow = new Date()
      const newSub: BillingSubscription = {
        _id: crypto.randomUUID(),
        userId: targetUserId,
        planId: STARTER_PLAN_ID,
        customAgentHoursLimit: null,
        customPrice: starterPlan?.price ?? 0,
        customPriceNote: null,
        agentHoursUsed: 0,
        overageHours: 0,
        currentPeriodStart: bootNow,
        currentPeriodEnd: addMonthsClampDay(bootNow, 1),
        status: 'active',
        startDate: bootNow,
        endDate: null,
        paymentMethod: 'manual',
        billingNotes: 'Auto-created via admin panel',
        createdAt: bootNow,
        updatedAt: bootNow,
      }
      await subsCol.insertOne(newSub)
      active = newSub
    }

    // Validate referenced entities up front (fail before any write).
    if (data.planId !== undefined) {
      const plan = await plansCol.findOne({ _id: data.planId })
      if (!plan) throw new HandlerError('INVALID_PLAN', `Plan ${data.planId} not found`)
    }
    if (data.terosProviderConfigId != null) {
      const configExists = await getTerosProviderConfigsCollection(db).findOne({
        _id: data.terosProviderConfigId,
      })
      if (!configExists) {
        throw new HandlerError(
          'INVALID_CONFIG',
          `Teros provider config ${data.terosProviderConfigId} not found`,
        )
      }
    }
    if (data.teamId != null) {
      const teamExists = await getBillingTeamsCollection(db).findOne({ _id: data.teamId })
      if (!teamExists) {
        throw new HandlerError('INVALID_TEAM', `Billing team ${data.teamId} not found`)
      }
    }

    const now = new Date()
    const isPlanChange = data.planId !== undefined && data.planId !== active.planId
    const isCancel = data.status === 'cancelled'

    // Field edits that apply to whichever sub ends up active.
    const edits: Record<string, any> = {}
    if (data.customPrice !== undefined) edits.customPrice = data.customPrice
    if (data.customPriceNote !== undefined) edits.customPriceNote = data.customPriceNote
    if (data.customAgentHoursLimit !== undefined) edits.customAgentHoursLimit = data.customAgentHoursLimit
    if (data.paymentMethod !== undefined) edits.paymentMethod = data.paymentMethod
    if (data.billingNotes !== undefined) edits.billingNotes = data.billingNotes
    if (data.terosProviderConfigId !== undefined) edits.terosProviderConfigId = data.terosProviderConfigId
    if (data.teamId !== undefined) edits.teamId = data.teamId

    // The sub to reflect in the response (the new one after a plan change).
    let resultSubId = active._id

    if (isPlanChange) {
      // Admin plan changes are IMMEDIATE in BOTH directions — an administrative
      // action, not a self-serve billing decision. (The self-serve billing.change-plan
      // defers a DOWNGRADE to the period end; routing the admin path through that
      // shared rule left an admin downgrade with the OLD plan still active and the
      // panel showing "no change" — TER-631.)
      // Admin grants/changes a tier as an administrative action and does NOT
      // auto-charge (decision Antonio, TER-626): no stripe → changeUserPlanImmediate
      // skips its best-effort balance transaction. Billing is handled out-of-band.
      resultSubId = await changeUserPlanImmediate(db, active, data.planId as string, now, {
        edits,
      })
    } else if (isCancel) {
      // Deferred cancellation (decision #7): keep the tier until currentPeriodEnd,
      // then billing-reset-cron closes it and opens a starter. NOT status:'cancelled'
      // (that would downgrade immediately). A cancel supersedes a pending downgrade.
      await subsCol.updateOne(
        { _id: active._id },
        { $set: { ...edits, cancelAtPeriodEnd: true, scheduledPlanChange: null, updatedAt: now } },
      )
    } else {
      // Plain edit on the active sub (status here is paused/active/past_due).
      const $set: Record<string, any> = { ...edits, updatedAt: now }
      if (data.status !== undefined) $set.status = data.status
      // Resuming an active sub clears a pending cancellation AND downgrade.
      if (data.status === 'active') {
        $set.cancelAtPeriodEnd = false
        $set.scheduledPlanChange = null
      }
      await subsCol.updateOne({ _id: active._id }, { $set })
    }

    // Fetch the touched subscription with plan name for response.
    const updatedSub = await subsCol.findOne({ _id: resultSubId })
    const plan = updatedSub ? await plansCol.findOne({ _id: updatedSub.planId }) : null

    // billingStatus is DERIVED from the latest invoice (the payment state lives
    // on the invoice, not the subscription). Read-only for the panel; Stripe
    // will own it in FASE 4. 'waived' when nothing has been invoiced yet.
    const lastInvoice = await getBillingInvoicesCollection(db).findOne(
      { userId: targetUserId },
      { sort: { periodEnd: -1, createdAt: -1 } },
    )
    const billingStatus = lastInvoice?.status ?? 'waived'

    console.log(`✅ Billing subscription updated for ${targetUserId} by ${ctx.userId}`)

    return {
      userId: targetUserId,
      subscription: {
        planId: updatedSub?.planId,
        planName: plan?.displayName ?? plan?.name ?? updatedSub?.planId,
        customPrice: updatedSub?.customPrice,
        customPriceNote: updatedSub?.customPriceNote,
        customAgentHoursLimit: updatedSub?.customAgentHoursLimit,
        agentHoursUsed: updatedSub?.agentHoursUsed ?? 0,
        overageHours: updatedSub?.overageHours ?? 0,
        status: updatedSub?.status,
        cancelAtPeriodEnd: updatedSub?.cancelAtPeriodEnd ?? false,
        scheduledPlanChange: updatedSub?.scheduledPlanChange ?? null,
        billingStatus,
        paymentMethod: updatedSub?.paymentMethod,
        billingNotes: updatedSub?.billingNotes,
        terosProviderConfigId: updatedSub?.terosProviderConfigId ?? null,
        teamId: updatedSub?.teamId ?? null,
        currentPeriodStart: updatedSub?.currentPeriodStart?.toISOString(),
        currentPeriodEnd: updatedSub?.currentPeriodEnd?.toISOString(),
      },
    }
  }
}
