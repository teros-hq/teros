/**
 * TER-596 G0 — Plan catalogue reconciliation.
 *
 * Three layers:
 *   1. Catalogue data — the seed matches the public pricing page exactly.
 *   2. Migration — reconciles an existing DB: corrects reused ids, remaps subs
 *      off retired plans, deletes retired plan docs; idempotent.
 *   3. Structural invariant (lint-as-test) — the entry-plan id is centralised in
 *      DEFAULT_PLAN_ID; no code re-hardcodes the literal 'plan_basic'.
 *
 * Catalogue as of the 2026-10-09 pricing update (41978ec18 + migration
 * 20261009_001): Seed 0€/2h (entry), Starter €19/8h, Growth €89/40h,
 * Pro €159/80h, Ultra €349/200h, Enterprise (contact sales).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BILLING_PLANS_SEED,
  RETIRED_PLAN_REMAP,
  DEFAULT_PLAN_ID,
} from '../../src/models/billing'
import migration from '../../src/migrations/20260622_002_reconcile_plan_catalog'
import { InMemoryDb } from './_stripe-test-helpers'

const byId = (id: string) => BILLING_PLANS_SEED.find((p) => p._id === id)

describe('catalogue data — mirrors the public pricing page', () => {
  test('exactly the 6 PUBLIC web tiers, in order (hidden tiers excluded)', () => {
    expect(BILLING_PLANS_SEED.filter((p) => p.isPublic).map((p) => p._id)).toEqual([
      'plan_seed',
      'plan_starter',
      'plan_growth',
      'plan_pro',
      'plan_ultra',
      'plan_enterprise',
    ])
  })

  test('Seed — free entry tier, 2h, includes teros', () => {
    const p = byId('plan_seed')!
    expect(p.price).toBe(0)
    expect(p.agentHoursLimit).toBe(2)
    expect(p.features.terosModel).toBe(true)
    expect(p.isPublic).toBe(true)
  })

  test('Starter — paid tier, €19, 8h, includes teros', () => {
    const p = byId('plan_starter')!
    expect(p.price).toBe(19)
    expect(p.postBetaPrice).toBeUndefined()
    expect(p.agentHoursLimit).toBe(8)
    expect(p.features.terosModel).toBe(true)
    expect(p.isPublic).toBe(true)
  })

  test('Growth — €89, 40h, marked Popular', () => {
    const p = byId('plan_growth')!
    expect(p.price).toBe(89)
    expect(p.agentHoursLimit).toBe(40)
    expect(p.popular).toBe(true)
  })

  test('Pro — €159, 80h (reused id, repriced from €179 by the 2026-10-09 pricing update)', () => {
    const p = byId('plan_pro')!
    expect(p.price).toBe(159)
    expect(p.agentHoursLimit).toBe(80)
  })

  test('Ultra — €349, 200h', () => {
    const p = byId('plan_ultra')!
    expect(p.price).toBe(349)
    expect(p.agentHoursLimit).toBe(200)
  })

  test('Enterprise — contact sales, unmetered (0h + terosModel ⇒ unlimited)', () => {
    const p = byId('plan_enterprise')!
    expect(p.contactSales).toBe(true)
    expect(p.agentHoursLimit).toBe(0)
    expect(p.features.terosModel).toBe(true)
  })

  test('the retired plan_unlimited is NOT seeded (migration 20261009_001 deletes it; seeding would re-create it)', () => {
    expect(byId('plan_unlimited')).toBeUndefined()
  })

  test('DEFAULT_PLAN_ID is the entry tier and exists in the catalogue', () => {
    expect(DEFAULT_PLAN_ID).toBe('plan_seed')
    expect(byId(DEFAULT_PLAN_ID)).toBeDefined()
  })

  test('retired ids are gone from the catalogue and map to real successors', () => {
    expect(RETIRED_PLAN_REMAP).toEqual({
      plan_basic: 'plan_seed',
      plan_max: 'plan_ultra',
      plan_infinity: 'plan_enterprise',
    })
    for (const oldId of Object.keys(RETIRED_PLAN_REMAP)) {
      expect(byId(oldId)).toBeUndefined() // retired ⇒ not seeded anymore
    }
    for (const newId of Object.values(RETIRED_PLAN_REMAP)) {
      expect(byId(newId)).toBeDefined() // successor exists
    }
  })
})

describe('migration — reconciles an existing DB', () => {
  function seedOldDb() {
    const db = new InMemoryDb()
    db.seed('billing_plans', [
      { _id: 'plan_basic', name: 'basic', price: 0, agentHoursLimit: 0, features: { terosModel: false } },
      { _id: 'plan_pro', name: 'pro', price: 89, agentHoursLimit: 80, features: { terosModel: true } },
      { _id: 'plan_max', name: 'max', price: 179, agentHoursLimit: 200, features: { terosModel: true } },
      { _id: 'plan_infinity', name: 'infinity', price: 0, agentHoursLimit: 1000, features: { terosModel: true } },
    ])
    db.seed('billing_subscriptions', [
      { _id: 'sub_pro', userId: 'u1', planId: 'plan_pro', status: 'active' },
      { _id: 'sub_max', userId: 'u2', planId: 'plan_max', status: 'active' },
      { _id: 'sub_basic', userId: 'u3', planId: 'plan_basic', status: 'active' },
      { _id: 'sub_infinity', userId: 'u4', planId: 'plan_infinity', status: 'active' },
      // Active on a kept plan, but with a deferred downgrade (F8) targeting a
      // RETIRED plan — the nested planId must be remapped too, or it dangles.
      {
        _id: 'sub_sched',
        userId: 'u5',
        planId: 'plan_pro',
        status: 'active',
        scheduledPlanChange: { planId: 'plan_max', scheduledAt: SCHEDULED_AT },
      },
    ])
    db.seed('billing_teams', [
      { _id: 'team_retired', planId: 'plan_infinity', name: 'Retired Co' },
      { _id: 'team_kept', planId: 'plan_pro', name: 'Kept Co' },
    ])
    return db
  }

  const SCHEDULED_AT = new Date('2026-07-01T00:00:00Z')

  test('upserts the 6 new plans, deletes the 3 retired, reprices reused plan_pro', async () => {
    const db = seedOldDb()
    await migration.up(db as any)
    const plans = db.collection('billing_plans')

    // retired plan docs are gone
    expect(await plans.findOne({ _id: 'plan_basic' })).toBeNull()
    expect(await plans.findOne({ _id: 'plan_max' })).toBeNull()
    expect(await plans.findOne({ _id: 'plan_infinity' })).toBeNull()

    // the 6 canonical plans exist
    for (const id of ['plan_seed', 'plan_starter', 'plan_growth', 'plan_pro', 'plan_ultra', 'plan_enterprise']) {
      expect(await plans.findOne({ _id: id })).not.toBeNull()
    }

    // reused plan_pro repriced in place ($set, not $setOnInsert)
    expect((await plans.findOne({ _id: 'plan_pro' }))!.price).toBe(159)
    // the entry tier carries its new meaning (2h + teros), not the old basic (0h)
    const seed = (await plans.findOne({ _id: 'plan_seed' }))!
    expect(seed.agentHoursLimit).toBe(2)
    expect(seed.features.terosModel).toBe(true)
  })

  test('remaps subscriptions off retired plans to their successor', async () => {
    const db = seedOldDb()
    await migration.up(db as any)
    const subs = db.collection('billing_subscriptions')

    expect((await subs.findOne({ _id: 'sub_pro' }))!.planId).toBe('plan_pro') // reused, unchanged
    expect((await subs.findOne({ _id: 'sub_max' }))!.planId).toBe('plan_ultra')
    expect((await subs.findOne({ _id: 'sub_basic' }))!.planId).toBe('plan_seed')
    expect((await subs.findOne({ _id: 'sub_infinity' }))!.planId).toBe('plan_enterprise')
  })

  test('idempotent — re-running leaves exactly the canonical catalogue and stable subs', async () => {
    const db = seedOldDb()
    await migration.up(db as any)
    await migration.up(db as any)
    // The reconcile upserts every canonical plan
    // and removes the retired ones → the DB holds exactly the seed, no duplicates.
    expect(await db.collection('billing_plans').countDocuments()).toBe(BILLING_PLANS_SEED.length)
    expect((await db.collection('billing_subscriptions').findOne({ _id: 'sub_max' }))!.planId).toBe('plan_ultra')
  })

  test('remaps retired planIds nested in scheduledPlanChange and in billing_teams', async () => {
    const db = seedOldDb()
    await migration.up(db as any)

    // MUST BITE: without the nested remap, scheduledPlanChange.planId stays the
    // retired 'plan_max' (dangling). scheduledAt must survive the rewrite.
    const sched = (await db.collection('billing_subscriptions').findOne({ _id: 'sub_sched' }))!
    expect(sched.scheduledPlanChange.planId).toBe('plan_ultra')
    expect(sched.scheduledPlanChange.scheduledAt).toEqual(SCHEDULED_AT)
    expect(sched.planId).toBe('plan_pro') // active plan was already current, untouched

    // MUST BITE: without the teams remap, team_retired.planId stays 'plan_infinity'.
    const teams = db.collection('billing_teams')
    expect((await teams.findOne({ _id: 'team_retired' }))!.planId).toBe('plan_enterprise')
    expect((await teams.findOne({ _id: 'team_kept' }))!.planId).toBe('plan_pro')
  })

  test('idempotent for the nested + team remaps too', async () => {
    const db = seedOldDb()
    await migration.up(db as any)
    await migration.up(db as any)
    const sched = (await db.collection('billing_subscriptions').findOne({ _id: 'sub_sched' }))!
    expect(sched.scheduledPlanChange.planId).toBe('plan_ultra')
    expect((await db.collection('billing_teams').findOne({ _id: 'team_retired' }))!.planId).toBe('plan_enterprise')
  })
})

describe('structural invariant — entry plan centralised, no re-hardcoded literal', () => {
  const SRC = (rel: string) => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
  // Sites that previously hardcoded 'plan_basic' as the entry/fallback plan.
  const CENTRALISED_FILES = [
    'services/billing-gate.ts',
    'services/billing-reset-cron.ts',
    'handlers/domains/admin/update-billing-subscription.ts',
    'models/billing.ts',
  ]

  test('DEFAULT_PLAN_ID resolves to plan_seed', () => {
    expect(DEFAULT_PLAN_ID).toBe('plan_seed')
  })

  test('no source file re-hardcodes the literal \'plan_basic\'', () => {
    for (const f of CENTRALISED_FILES) {
      const src = SRC(f)
      expect(src).not.toMatch(/['"]plan_basic['"]/)
    }
  })

  test('the gate/reset/admin sites reference DEFAULT_PLAN_ID', () => {
    for (const f of ['services/billing-gate.ts', 'services/billing-reset-cron.ts', 'handlers/domains/admin/update-billing-subscription.ts']) {
      expect(SRC(f)).toContain('DEFAULT_PLAN_ID')
    }
  })
})
