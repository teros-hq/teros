/**
 * StripePaymentService — customer mapping + payment-method vaulting (FASE 4b).
 *
 * Asserts the EXACT persisted mapping and the EXACT Stripe calls (method +
 * idempotency key), not just "it was called". The idempotency key on
 * createCustomer is what makes concurrent first-time calls converge on one
 * Stripe customer, so it's asserted explicitly.
 *
 * MUST BITE — confirmed against mutants:
 *   - drop the `existing?.stripeCustomerId` short-circuit → the "no 2nd
 *     createCustomer" assertion goes red (a duplicate customer would be made).
 *   - drop the idempotencyKey on createCustomer → the key assertion red.
 *   - skip persisting defaultPaymentMethodId → vaulting test red.
 *   - make a method no-op instead of throwing when disabled → disabled test red.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { StripePaymentError } from '../../src/services/_stripe-error'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

function setup() {
  const db = new InMemoryDb()
  const stripe = new FakeStripe()
  const svc = new StripePaymentService(db as unknown as Db, stripe)
  return { db, stripe, svc }
}

describe('StripePaymentService.createOrSyncCustomer', () => {
  it('creates a Stripe customer and persists the mapping (idempotency key set)', async () => {
    const { db, stripe, svc } = setup()

    const customer = await svc.createOrSyncCustomer('user_1', {
      email: 'a@test.com',
      name: 'Ada',
    })

    expect(customer.stripeCustomerId).toBe('cus_1')
    expect(customer.defaultPaymentMethodId).toBeNull()
    expect(customer.userId).toBe('user_1')

    // Persisted exactly once with the Stripe id.
    const stored = await db.collection('billing_customers').findOne({ _id: 'user_1' })
    expect(stored?.stripeCustomerId).toBe('cus_1')

    // Created on Stripe with the per-user idempotency key + metadata.
    const creates = stripe.calls.filter((c) => c.method === 'createCustomer')
    expect(creates).toHaveLength(1)
    expect(creates[0].idempotencyKey).toBe('customer:user_1')
    expect(creates[0].args[0]).toEqual({
      email: 'a@test.com',
      name: 'Ada',
      metadata: { terosUserId: 'user_1' },
    })
  })

  it('is idempotent: a second call returns the mapping without a new Stripe customer', async () => {
    const { stripe, svc } = setup()
    const first = await svc.createOrSyncCustomer('user_1', { email: 'a@test.com' })
    const second = await svc.createOrSyncCustomer('user_1', { email: 'a@test.com' })

    expect(second.stripeCustomerId).toBe(first.stripeCustomerId)
    expect(stripe.calls.filter((c) => c.method === 'createCustomer')).toHaveLength(1)
  })
})

describe('StripePaymentService.createSetupIntent', () => {
  it('ensures a customer and returns the client secret', async () => {
    const { svc } = setup()
    const res = await svc.createSetupIntent('user_1', { email: 'a@test.com' })

    expect(res.setupIntentId).toBe('seti_2') // cus_1 is seq 1, seti is seq 2
    expect(res.clientSecret).toBe('seti_2_secret')
    expect(res.stripeCustomerId).toBe('cus_1')
  })
})

describe('StripePaymentService.setDefaultPaymentMethod', () => {
  it('attaches the PM, sets it as default on Stripe, and persists it', async () => {
    const { db, stripe, svc } = setup()
    await svc.createOrSyncCustomer('user_1', { email: 'a@test.com' })

    const updated = await svc.setDefaultPaymentMethod('user_1', 'pm_card')

    expect(updated.defaultPaymentMethodId).toBe('pm_card')
    const stored = await db.collection('billing_customers').findOne({ _id: 'user_1' })
    expect(stored?.defaultPaymentMethodId).toBe('pm_card')

    const attach = stripe.calls.find((c) => c.method === 'attachPaymentMethod')
    expect(attach?.args).toEqual(['pm_card', 'cus_1'])
    const update = stripe.calls.find((c) => c.method === 'updateCustomer')
    expect(update?.args[1]).toEqual({ invoice_settings: { default_payment_method: 'pm_card' } })
  })
})

describe('StripePaymentService when Stripe is not configured', () => {
  it('is disabled and fails loud instead of silently no-op', async () => {
    const db = new InMemoryDb()
    const svc = new StripePaymentService(db as unknown as Db, null)

    expect(svc.isEnabled()).toBe(false)
    await expect(svc.createOrSyncCustomer('user_1')).rejects.toBeInstanceOf(StripePaymentError)
    await expect(svc.createSetupIntent('user_1')).rejects.toThrow('[STRIPE_NOT_CONFIGURED]')

    // Nothing was persisted.
    expect(await db.collection('billing_customers').countDocuments()).toBe(0)
  })
})

describe('StripePaymentService.getDefaultCard', () => {
  it('returns the card details of the vaulted default method', async () => {
    const { db, svc } = setup()
    db.seed('billing_customers', [
      { _id: 'u1', userId: 'u1', stripeCustomerId: 'cus_1', defaultPaymentMethodId: 'pm_1' },
    ])
    expect(await svc.getDefaultCard('u1')).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 4,
      expYear: 2027,
    })
  })

  it('returns null (no throw) when there is no vaulted method', async () => {
    const { db, svc } = setup()
    db.seed('billing_customers', [
      { _id: 'u1', userId: 'u1', stripeCustomerId: 'cus_1', defaultPaymentMethodId: null },
    ])
    expect(await svc.getDefaultCard('u1')).toBeNull()
  })

  it('returns null (never throws) when the customer lookup fails — contract for get-subscription', async () => {
    const { db, svc } = setup()
    ;(db.collection('billing_customers') as any).findOne = async () => {
      throw new Error('mongo down')
    }
    // MUST BITE: with getCustomer OUTSIDE the try/catch, this rejects instead of
    // resolving null → get-subscription's Promise.all rejects → the whole
    // subscription view 500s on a transient Mongo hiccup.
    expect(await svc.getDefaultCard('u1')).toBeNull()
  })
})
