/**
 * Migration 20261009_001 (pricing update) on the two DB shapes it meets:
 *
 *   - LEGACY DB (pre-2026-10-09): plan_starter is the old FREE tier (0€/10h, postBetaPrice)
 *     → renamed to plan_seed; plan_starter_paid → plan_starter.
 *   - FRESH DB: server bootstrap seeds BILLING_PLANS_SEED (already the new catalogue:
 *     plan_seed + the paid €19/8h plan_starter) BEFORE migrations run. The migration
 *     must leave the new plan_starter alone — it used to delete it in the
 *     "plan_seed already exists" branch, so every fresh environment (CI, new installs)
 *     booted without the Starter tier.
 */
import { describe, expect, test } from 'bun:test'
import migration from '../../src/migrations/20261009_001_pricing_update_alvaro'
import { BILLING_PLANS_SEED } from '../../src/models/billing'
import { InMemoryDb } from './_stripe-test-helpers'

const now = new Date()

async function planIds(db: InMemoryDb): Promise<string[]> {
  const docs = await db.collection('billing_plans').find({}).toArray()
  return docs.map((d) => d._id as string).sort()
}

describe('20261009_001 pricing update', () => {
  test('fresh DB (plans seeded before migrations): the paid plan_starter survives', async () => {
    const db = new InMemoryDb()
    for (const p of BILLING_PLANS_SEED) {
      await db.collection('billing_plans').insertOne({ ...p, createdAt: now, updatedAt: now })
    }
    const seeded = await planIds(db)

    await migration.up(db as any)

    expect(await planIds(db)).toEqual(seeded)
    const starter = await db.collection('billing_plans').findOne({ _id: 'plan_starter' })
    expect(starter?.price).toBe(19)
    expect(starter?.agentHoursLimit).toBe(8)
  })

  test('legacy DB: old free plan_starter → plan_seed, plan_starter_paid → plan_starter', async () => {
    const db = new InMemoryDb()
    const plans = db.collection('billing_plans')
    await plans.insertOne({
      _id: 'plan_starter',
      name: 'starter',
      price: 0,
      agentHoursLimit: 10,
      postBetaPrice: 9,
      createdAt: now,
      updatedAt: now,
    })
    await plans.insertOne({
      _id: 'plan_starter_paid',
      name: 'starter_paid',
      price: 19,
      agentHoursLimit: 8,
      createdAt: now,
      updatedAt: now,
    })
    await plans.insertOne({ _id: 'plan_pro', name: 'pro', price: 179, agentHoursLimit: 80 })

    await migration.up(db as any)

    expect(await planIds(db)).toEqual(['plan_pro', 'plan_seed', 'plan_starter'])
    expect((await plans.findOne({ _id: 'plan_seed' }))?.agentHoursLimit).toBe(2)
    expect((await plans.findOne({ _id: 'plan_starter' }))?.price).toBe(19)
    expect((await plans.findOne({ _id: 'plan_pro' }))?.price).toBe(159)
  })

  test('plan_seed already present + OLD free plan_starter left over → the leftover is removed', async () => {
    const db = new InMemoryDb()
    const plans = db.collection('billing_plans')
    await plans.insertOne({ _id: 'plan_seed', name: 'seed', price: 0, agentHoursLimit: 2 })
    await plans.insertOne({
      _id: 'plan_starter',
      name: 'starter',
      price: 0,
      agentHoursLimit: 10,
      postBetaPrice: 9,
    })

    await migration.up(db as any)

    expect(await planIds(db)).toEqual(['plan_seed'])
  })
})
