/**
 * BETA → paid price change + grandfathering (FASE 4h).
 *
 * The mechanism is catalog-agnostic and NEVER touches billing_invoices, so
 * already-issued €0 invoices can't be re-billed. Founding partners keep €0; the
 * rest fall through to the new list price; negotiated custom deals are left
 * alone. Asserts the exact resulting effective price per cohort.
 *
 * MUST BITE:
 *   - drop the `customPrice: 0` filter in liftBetaDiscount → it would also wipe
 *     a negotiated custom price (the €50 deal test goes red).
 *   - ignore exceptUserIds → the founding-partner test goes red.
 *   - make setPlanPrice silently upsert an unknown plan → the throw test red.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { getEffectivePrice } from '../../src/models/billing'
import {
  grandfatherUsers,
  liftBetaDiscount,
  setPlanPrice,
} from '../../src/services/billing-pricing'
import { InMemoryDb } from './_stripe-test-helpers'

function sub(userId: string, over: Record<string, any> = {}) {
  return {
    _id: `sub_${userId}`,
    userId,
    planId: 'plan_pro',
    customPrice: 0, // BETA free
    customPriceNote: null,
    customAgentHoursLimit: null,
    status: 'active',
    ...over,
  }
}

function seed() {
  const db = new InMemoryDb()
  db.seed('billing_plans', [{ _id: 'plan_pro', name: 'pro', price: 0, currency: 'EUR', agentHoursLimit: 80 }])
  db.seed('billing_subscriptions', [
    sub('partner'), // founding partner — stays €0
    sub('regular'), // BETA free — should start paying
    sub('deal', { customPrice: 50 }), // negotiated deal — untouched
    sub('other_plan', { planId: 'plan_max' }), // different plan — untouched
    sub('ended_user', { status: 'ended' }), // not active — untouched
  ])
  return db
}

describe('setPlanPrice', () => {
  it('updates the list price and reports the previous one', async () => {
    const db = seed()
    const res = await setPlanPrice(db as unknown as Db, 'plan_pro', 89)
    expect(res).toEqual({ updated: true, previousPrice: 0 })
    expect((await db.collection('billing_plans').findOne({ _id: 'plan_pro' }))?.price).toBe(89)
  })

  it('throws on an unknown plan instead of creating one', async () => {
    const db = seed()
    await expect(setPlanPrice(db as unknown as Db, 'plan_ghost', 50)).rejects.toThrow('not found')
    await expect(setPlanPrice(db as unknown as Db, 'plan_pro', -5)).rejects.toThrow('>= 0')
  })
})

describe('grandfatherUsers', () => {
  it('locks a customPrice + note on active subs', async () => {
    const db = seed()
    const res = await grandfatherUsers(db as unknown as Db, ['partner'], 0)
    expect(res.grandfathered).toBe(1)
    const s = await db.collection('billing_subscriptions').findOne({ userId: 'partner' })
    expect(s?.customPrice).toBe(0)
    expect(s?.customPriceNote).toContain('Founding partner')
  })
})

describe('liftBetaDiscount', () => {
  it('lifts only non-grandfathered BETA subs on the plan, leaving deals + partners + other plans', async () => {
    const db = seed()
    // Founding partner is excepted; everyone else on plan_pro with customPrice 0 is lifted.
    const res = await liftBetaDiscount(db as unknown as Db, 'plan_pro', ['partner'])
    expect(res.lifted).toBe(1) // only 'regular'

    const get = async (u: string) => db.collection('billing_subscriptions').findOne({ userId: u })
    expect((await get('regular'))?.customPrice).toBeNull() // now bills list price
    expect((await get('partner'))?.customPrice).toBe(0) // grandfathered
    expect((await get('deal'))?.customPrice).toBe(50) // negotiated deal untouched
    expect((await get('other_plan'))?.customPrice).toBe(0) // different plan untouched
    expect((await get('ended_user'))?.customPrice).toBe(0) // not active untouched
  })
})

describe('end-to-end BETA exit', () => {
  it('partners stay €0 while everyone else bills the new list price', async () => {
    const db = seed()
    const plan = { price: 89 }

    await grandfatherUsers(db as unknown as Db, ['partner'], 0)
    await setPlanPrice(db as unknown as Db, 'plan_pro', 89)
    await liftBetaDiscount(db as unknown as Db, 'plan_pro', ['partner'])

    const partner = await db.collection('billing_subscriptions').findOne({ userId: 'partner' })
    const regular = await db.collection('billing_subscriptions').findOne({ userId: 'regular' })

    // Effective price = customPrice ?? plan.price.
    expect(getEffectivePrice(partner as any, plan)).toBe(0)
    expect(getEffectivePrice(regular as any, plan)).toBe(89)
  })
})
