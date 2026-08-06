/**
 * Default (Starter/"Basic") subscription on signup.
 *
 * The onboarding simplification removed the plan-selection step, so EVERY user
 * relies on `UserService.createUser` provisioning a Starter subscription at
 * signup. Two guards:
 *   1. `createDefaultSubscription` produces an active Starter sub (the data).
 *   2. `createUser` still calls it (the wiring — a silent removal would leave
 *      new users without a subscription; only the billing-gate fallback saves
 *      them, and that's not the contract we want to ship untested).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { STARTER_PLAN_ID, createDefaultSubscription } from '../../src/models/billing'
import { InMemoryDb } from './_stripe-test-helpers'

const here = dirname(fileURLToPath(import.meta.url))

describe('createDefaultSubscription', () => {
  it('creates an active Starter subscription with zero hours used', async () => {
    const db = new InMemoryDb()
    const sub = await createDefaultSubscription(db as any, 'user_x')

    expect(sub.userId).toBe('user_x')
    expect(sub.planId).toBe(STARTER_PLAN_ID)
    expect(sub.planId).toBe('plan_starter')
    expect(sub.status).toBe('active')
    expect(sub.agentHoursUsed).toBe(0)
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(sub.currentPeriodStart.getTime())

    // …and it is persisted, not just returned.
    const stored = await db.collection('billing_subscriptions').findOne({ userId: 'user_x' })
    expect(stored?.planId).toBe('plan_starter')
    expect(stored?.status).toBe('active')
  })
})

describe('createUser wiring', () => {
  it('still provisions the default subscription on signup', () => {
    // Lint-as-test: a refactor that drops the createDefaultSubscription call from
    // createUser would leave new users without a subscription, undetected by the
    // unit above. This fails loudly if the wiring disappears.
    const src = readFileSync(resolve(here, '../../src/auth/user-service.ts'), 'utf8')
    expect(src.includes('createDefaultSubscription(')).toBe(true)
  })
})
