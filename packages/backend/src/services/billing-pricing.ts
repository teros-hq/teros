/**
 * Price-change + grandfathering mechanism (FASE 4h, decision #14).
 *
 * Building blocks for the BETA → paid transition, CATALOG-AGNOSTIC (no prices
 * hardcoded — the actual numbers are Antonio + Pablo's call, decision #9):
 *
 *   - setPlanPrice          raise/lower a plan's list price.
 *   - grandfatherUsers      lock a per-user customPrice (founding partners → €0)
 *                           so a list-price change never touches them.
 *   - liftBetaDiscount      clear the €0 BETA customPrice for everyone on a plan
 *                           except the grandfathered set → they bill the list
 *                           price going forward.
 *
 * "Without re-billing the €0 period" (decision #14) holds BY CONSTRUCTION: none
 * of these touch billing_invoices, so already-issued €0 invoices are never
 * re-billed. The change takes effect on the NEXT period close (the reset-cron
 * reads getEffectivePrice at close), so run the lift at a period boundary if the
 * in-flight period must also stay free.
 */

import type { Db } from 'mongodb'
import {
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
} from '../models/billing.js'

function assertPrice(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`)
  }
}

/**
 * Set a plan's list price. Subs without a customPrice override bill at this
 * price from their next period close. Throws if the plan doesn't exist
 * (fail loud — never silently create pricing).
 */
export async function setPlanPrice(
  db: Db,
  planId: string,
  newPrice: number,
): Promise<{ updated: boolean; previousPrice: number }> {
  assertPrice(newPrice, 'newPrice')
  const plansCol = getBillingPlansCollection(db)
  const plan = await plansCol.findOne({ _id: planId })
  if (!plan) throw new Error(`setPlanPrice: plan ${planId} not found`)

  await plansCol.updateOne({ _id: planId }, { $set: { price: newPrice, updatedAt: new Date() } })
  return { updated: plan.price !== newPrice, previousPrice: plan.price }
}

/**
 * Lock a customPrice on the given users' ACTIVE subscriptions so a list-price
 * change can never affect them (founding partners → lockedPrice 0). Stamps a
 * note for auditability. Idempotent. Returns how many subs were stamped.
 */
export async function grandfatherUsers(
  db: Db,
  userIds: string[],
  lockedPrice = 0,
  note = 'Founding partner — grandfathered price',
): Promise<{ grandfathered: number }> {
  assertPrice(lockedPrice, 'lockedPrice')
  const subsCol = getBillingSubscriptionsCollection(db)
  let grandfathered = 0
  for (const userId of userIds) {
    const res = await subsCol.updateOne(
      { userId, status: 'active' },
      { $set: { customPrice: lockedPrice, customPriceNote: note, updatedAt: new Date() } },
    )
    if ((res.modifiedCount ?? 0) > 0 || (res.matchedCount ?? 0) > 0) grandfathered++
  }
  return { grandfathered }
}

/**
 * Clear the €0 BETA discount on active subs of a plan so they fall through to
 * the plan's list price — EXCEPT the grandfathered set. Only lifts subs whose
 * customPrice is exactly 0 (the BETA free price): a negotiated custom price
 * (e.g. a per-company deal) is left untouched. Returns how many were lifted.
 */
export async function liftBetaDiscount(
  db: Db,
  planId: string,
  exceptUserIds: string[] = [],
): Promise<{ lifted: number }> {
  const subsCol = getBillingSubscriptionsCollection(db)
  const except = new Set(exceptUserIds)

  const subs = await subsCol.find({ planId, status: 'active', customPrice: 0 }).toArray()
  let lifted = 0
  for (const sub of subs) {
    if (except.has(sub.userId)) continue
    await subsCol.updateOne(
      { _id: sub._id },
      { $set: { customPrice: null, customPriceNote: null, updatedAt: new Date() } },
    )
    lifted++
  }
  return { lifted }
}
