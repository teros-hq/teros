/**
 * Shared subscription operations.
 *
 * Extracted so the admin panel (admin.update-billing-subscription) and the
 * request-access approval flow (admin.resolve-access-request → upgrade) apply an
 * IDENTICAL immediate plan change instead of two divergent copies — exactly the
 * "change the meaning of a write in one place but not the other" bug class.
 */

import type { Db } from 'mongodb'
import {
  addMonthsClampDay,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  type BillingSubscription,
} from '../models/billing.js'

/** Field overrides carried onto the new subscription (admin panel edits). */
export interface PlanChangeEdits {
  customAgentHoursLimit?: number | null
  customPrice?: number | null
  customPriceNote?: string | null
  paymentMethod?: 'stripe' | 'manual'
  billingNotes?: string
  terosProviderConfigId?: string | null
  teamId?: string | null
}

/**
 * Immediate UPGRADE (or lateral change) WITH history (decisions A/#6): close the
 * active sub and open a new active one on `newPlanId`. Used only for upgrades and
 * lateral changes — a DOWNGRADE is deferred to period end by the caller (decision
 * D), not routed here. Closes FIRST so the partial unique index
 * (billing_sub_one_active) never sees two active subs for this user.
 *
 * The new sub (decision A):
 *   - is active NOW (immediate access, not day+1);
 *   - keeps the ORIGINAL cut as currentPeriodEnd (the user already paid that
 *     period, so the next bill lands on the same date), not now+1 month;
 *   - gets ALL the new plan's hours fresh (agentHoursUsed reset to 0) — generous
 *     by design, to make upgrading attractive;
 *   - carries a fresh billing cursor so pre-change hours are not re-billed.
 *
 * Returns the new active subscription's _id.
 *
 * The prorated UPGRADE charge — (newPrice − oldPrice) × remaining/period — is
 * best-effort: a Stripe failure must NOT fail the plan change (the charge is
 * keyed idempotently by the new sub id and can be reapplied). €0 BETA → 0 → no-op.
 */
export async function changeUserPlanImmediate(
  db: Db,
  active: BillingSubscription,
  newPlanId: string,
  now: Date,
  opts: { edits?: PlanChangeEdits } = {},
): Promise<string> {
  const subsCol = getBillingSubscriptionsCollection(db)
  const edits = opts.edits ?? {}

  await subsCol.updateOne(
    { _id: active._id },
    { $set: { status: 'ended', endDate: now, cancelAtPeriodEnd: false, resetting: false, updatedAt: now } },
  )

  // Immediate access from `now`; keep the ORIGINAL cut so the next bill lands on
  // the same date (decision A). Guard: if the period already lapsed (edge: change
  // applied after the cut, before the reset-cron renewed), fall back to a fresh
  // month so we never write an inverted [start, end) window.
  const periodStart = now
  const periodEnd =
    active.currentPeriodEnd.getTime() > now.getTime()
      ? active.currentPeriodEnd
      : addMonthsClampDay(now, 1)
  const newActive: BillingSubscription = {
    _id: crypto.randomUUID(),
    userId: active.userId,
    planId: newPlanId,
    customAgentHoursLimit: edits.customAgentHoursLimit ?? null,
    customPrice: edits.customPrice ?? null,
    customPriceNote: edits.customPriceNote ?? null,
    agentHoursUsed: 0,
    overageHours: 0,
    // Fresh billing cursor: pre-change hours are not billed onto the new plan.
    lastBilledHourBucket: now,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    status: 'active',
    startDate: now,
    endDate: null,
    paymentMethod: edits.paymentMethod ?? active.paymentMethod ?? 'manual',
    billingNotes: edits.billingNotes ?? '',
    terosProviderConfigId: edits.terosProviderConfigId ?? active.terosProviderConfigId ?? null,
    teamId: edits.teamId ?? active.teamId ?? null,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await subsCol.insertOne(newActive)
  } catch (err) {
    // Compensation (TER-625): we closed the old sub FIRST (the partial unique index
    // billing_sub_one_active forbids two active subs), so a failed insert would
    // leave the user with NO active subscription — which the gate then blocks. Teros
    // uses no Mongo transactions; mirroring the codebase's compensation-over-
    // transaction pattern, re-OPEN the old sub to its pre-change state and rethrow,
    // so the change is all-or-nothing instead of orphaning the user.
    await subsCol.updateOne(
      { _id: active._id },
      {
        $set: {
          status: active.status,
          endDate: active.endDate ?? null,
          cancelAtPeriodEnd: active.cancelAtPeriodEnd ?? false,
          resetting: active.resetting ?? false,
          updatedAt: now,
        },
      },
    )
    throw err
  }

  return newActive._id
}

/**
 * Decide and apply a plan change by DIRECTION (decisions A/D) — the single place
 * that both the admin panel (admin.update-billing-subscription) and the
 * user-facing self-serve change (billing.change-plan) route through, so the
 * upgrade-vs-downgrade rule can never diverge between them.
 *
 *   - newPrice  <  oldPrice → DOWNGRADE: deferred to period end. Keep the current
 *     tier until the cut; set `scheduledPlanChange` (reuses the cancelAtPeriodEnd
 *     deferral the reset-cron already honours). No proration charge — the period
 *     is already paid at the current plan. `edits` apply to the current sub now.
 *   - otherwise → UPGRADE / lateral: applied immediately via changeUserPlanImmediate
 *     (fresh hours + prorated charge of the difference, €0 in BETA).
 *
 * Price is the EFFECTIVE price: the sub's customPrice override (or admin's
 * customPrice edit for the new plan) wins over the plan's list price. Callers
 * MUST have validated that `newPlanId` exists.
 */
export async function applyPlanChange(
  db: Db,
  active: BillingSubscription,
  newPlanId: string,
  now: Date,
  opts: { edits?: PlanChangeEdits } = {},
): Promise<{ kind: 'upgraded' | 'downgrade_scheduled'; subId: string }> {
  const plansCol = getBillingPlansCollection(db)
  const subsCol = getBillingSubscriptionsCollection(db)
  const edits = opts.edits ?? {}

  const [activePlan, newPlan] = await Promise.all([
    plansCol.findOne({ _id: active.planId }),
    plansCol.findOne({ _id: newPlanId }),
  ])
  const oldPrice = active.customPrice ?? activePlan?.price ?? 0
  const newPrice = (edits.customPrice as number | null | undefined) ?? newPlan?.price ?? 0

  if (newPrice < oldPrice) {
    await subsCol.updateOne(
      { _id: active._id },
      {
        $set: {
          ...edits,
          scheduledPlanChange: { planId: newPlanId, scheduledAt: now },
          cancelAtPeriodEnd: false,
          updatedAt: now,
        },
      },
    )
    return { kind: 'downgrade_scheduled', subId: active._id }
  }

  const subId = await changeUserPlanImmediate(db, active, newPlanId, now, { edits })
  return { kind: 'upgraded', subId }
}
