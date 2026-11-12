/**
 * billing.* vaulting handlers (FASE 4b).
 *
 * Thin handlers over StripePaymentService: assert they (1) resolve the caller's
 * profile into the SetupIntent, (2) surface the publishable key, (3) validate
 * input, and (4) map StripePaymentError → HandlerError with the SAME code (so
 * the frontend can branch). Asserts exact return shapes + thrown codes.
 *
 * MUST BITE:
 *   - drop the publishableKey from the response → setup-intent test red.
 *   - drop the empty-string guard on paymentMethodId → validation test red.
 *   - swallow StripePaymentError instead of rethrowing as HandlerError →
 *     disabled tests red.
 */

import { describe, expect, it } from 'bun:test'
import type { Db } from 'mongodb'
import { HandlerError } from '../../src/ws-framework/WsRouter'
import { StripePaymentService } from '../../src/services/stripe-payment-service'
import { createCreateSetupIntentHandler } from '../../src/handlers/domains/billing/create-setup-intent'
import { createSetPaymentMethodHandler } from '../../src/handlers/domains/billing/set-payment-method'
import { createCompleteSetupIntentHandler } from '../../src/handlers/domains/billing/complete-setup-intent'
import { createSetBillingDetailsHandler } from '../../src/handlers/domains/billing/set-billing-details'
import { FakeStripe, InMemoryDb } from './_stripe-test-helpers'

const ctx = { userId: 'user_1' } as any

function userServiceWith(profile: { email?: string; displayName?: string } | null) {
  return {
    async getByUserId() {
      return profile ? { userId: 'user_1', profile } : null
    },
  } as any
}

describe('billing.create-setup-intent', () => {
  it('returns the client secret + publishable key, using the caller profile', async () => {
    const db = new InMemoryDb()
    const stripe = new StripePaymentService(db as unknown as Db, new FakeStripe(), 'pk_test_123')
    const handler = createCreateSetupIntentHandler(
      userServiceWith({ email: 'ada@test.com', displayName: 'Ada' }),
      stripe,
    )

    const res = await handler(ctx)

    expect(res).toEqual({
      setupIntentId: 'seti_2',
      clientSecret: 'seti_2_secret',
      publishableKey: 'pk_test_123',
    })
    // The customer was created with the resolved profile.
    const cust = await db.collection('billing_customers').findOne({ _id: 'user_1' })
    expect(cust?.stripeCustomerId).toBe('cus_1')
  })

  it('throws STRIPE_NOT_CONFIGURED when Stripe is disabled', async () => {
    const db = new InMemoryDb()
    const stripe = new StripePaymentService(db as unknown as Db, null)
    const handler = createCreateSetupIntentHandler(userServiceWith(null), stripe)

    await expect(handler(ctx)).rejects.toThrow(HandlerError)
    await expect(handler(ctx)).rejects.toMatchObject({ code: 'STRIPE_NOT_CONFIGURED' })
  })
})

describe('billing.set-payment-method', () => {
  it('persists the default PM and returns it', async () => {
    const db = new InMemoryDb()
    const svc = new StripePaymentService(db as unknown as Db, new FakeStripe())
    await svc.createOrSyncCustomer('user_1')
    const handler = createSetPaymentMethodHandler(svc)

    const res = await handler(ctx, { paymentMethodId: 'pm_abc' })

    expect(res).toEqual({ ok: true, defaultPaymentMethodId: 'pm_abc', subscriptionSwitched: false })
  })

  it('rejects a missing/blank paymentMethodId before any Stripe call', async () => {
    const db = new InMemoryDb()
    const stripe = new FakeStripe()
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    const handler = createSetPaymentMethodHandler(svc)

    await expect(handler(ctx, { paymentMethodId: '   ' })).rejects.toMatchObject({
      code: 'MISSING_FIELDS',
    })
    await expect(handler(ctx, {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' })
    expect(stripe.calls.filter((c) => c.method === 'attachPaymentMethod')).toHaveLength(0)
  })

  it('maps a Stripe failure to a HandlerError with the classified code', async () => {
    const db = new InMemoryDb()
    const stripe = new FakeStripe()
    stripe.attachPaymentMethod = async () => {
      throw { type: 'StripeInvalidRequestError', message: 'No such PaymentMethod: pm_x' }
    }
    const svc = new StripePaymentService(db as unknown as Db, stripe)
    await svc.createOrSyncCustomer('user_1')
    const handler = createSetPaymentMethodHandler(svc)

    await expect(handler(ctx, { paymentMethodId: 'pm_x' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('a vaulted card switches the active subscription to stripe', () => {
  it('set-payment-method flips paymentMethod manual → stripe (renewals get charged)', async () => {
    const db = new InMemoryDb()
    await db.collection('billing_subscriptions').insertOne({ _id: 'sub_1', userId: 'user_1', status: 'active', paymentMethod: 'manual' })
    await db.collection('billing_subscriptions').insertOne({ _id: 'sub_old', userId: 'user_1', status: 'ended', paymentMethod: 'manual' })
    const stripe = new StripePaymentService(db as unknown as Db, new FakeStripe(), 'pk_test_123')
    const handler = createSetPaymentMethodHandler(stripe, db as unknown as Db)
    const res = (await handler(ctx, { paymentMethodId: 'pm_card' })) as any
    expect(res.subscriptionSwitched).toBe(true)
    expect((await db.collection('billing_subscriptions').findOne({ _id: 'sub_1' }))!.paymentMethod).toBe('stripe')
    expect((await db.collection('billing_subscriptions').findOne({ _id: 'sub_old' }))!.paymentMethod).toBe('manual')
    // Idempotent: a second card does not report a switch
    const again = (await handler(ctx, { paymentMethodId: 'pm_card2' })) as any
    expect(again.subscriptionSwitched).toBe(false)
  })
})

describe('billing.complete-setup-intent (3DS / redirect return)', () => {
  it('reads the intent back, stores its payment method and switches the subscription', async () => {
    const db = new InMemoryDb()
    await db.collection('billing_subscriptions').insertOne({ _id: 'sub_1', userId: 'user_1', status: 'active', paymentMethod: 'manual' })
    const fake = new FakeStripe()
    const stripe = new StripePaymentService(db as unknown as Db, fake, 'pk_test_123')
    const { setupIntentId } = await stripe.createSetupIntent('user_1')
    fake.confirmSetupIntent(setupIntentId, 'pm_3ds_card')
    const handler = createCompleteSetupIntentHandler(stripe, db as unknown as Db)
    const res = (await handler(ctx, { setupIntentId })) as any
    expect(res.defaultPaymentMethodId).toBe('pm_3ds_card')
    expect(res.subscriptionSwitched).toBe(true)
    expect((await db.collection('billing_customers').findOne({ _id: 'user_1' }))!.defaultPaymentMethodId).toBe('pm_3ds_card')
  })

  it('refuses an intent that did not succeed, one of another customer, and a malformed id', async () => {
    const db = new InMemoryDb()
    const fake = new FakeStripe()
    const stripe = new StripePaymentService(db as unknown as Db, fake, 'pk_test_123')
    const { setupIntentId } = await stripe.createSetupIntent('user_1')
    const handler = createCompleteSetupIntentHandler(stripe, db as unknown as Db)
    await expect(handler(ctx, { setupIntentId })).rejects.toThrow(/SETUP_INTENT_NOT_SUCCEEDED|did not complete/)
    const other = await stripe.createSetupIntent('user_2')
    fake.confirmSetupIntent(other.setupIntentId, 'pm_other')
    await expect(handler(ctx, { setupIntentId: other.setupIntentId })).rejects.toThrow(/SETUP_INTENT_FOREIGN|does not belong/)
    await expect(handler(ctx, { setupIntentId: 'nope' })).rejects.toThrow(HandlerError)
    expect(await db.collection('billing_customers').findOne({ _id: 'user_1' })).toMatchObject({ defaultPaymentMethodId: null })
  })
})

describe('billing.set-billing-details', () => {
  it('stores country + tax id on the customer and pushes them to Stripe', async () => {
    const db = new InMemoryDb()
    const fake = new FakeStripe()
    const stripe = new StripePaymentService(db as unknown as Db, fake, 'pk_test_123')
    const handler = createSetBillingDetailsHandler(stripe)
    const res = (await handler(ctx, { country: 'es', taxId: 'ESB12345678', taxIdType: 'eu_vat' })) as any
    expect(res).toMatchObject({ ok: true, country: 'ES', taxId: 'ESB12345678', taxIdType: 'eu_vat' })
    expect(fake.calls.find((c) => c.method === 'updateCustomer')!.args[1]).toEqual({ address: { country: 'ES' } })
    expect(fake.calls.find((c) => c.method === 'createCustomerTaxId')!.args[1]).toEqual({ type: 'eu_vat', value: 'ESB12345678' })
    // Same details again → no second tax id
    await handler(ctx, { country: 'ES', taxId: 'ESB12345678', taxIdType: 'eu_vat' })
    expect(fake.calls.filter((c) => c.method === 'createCustomerTaxId')).toHaveLength(1)
  })

  it('validates the country and requires a type with a tax id', async () => {
    const db = new InMemoryDb()
    const stripe = new StripePaymentService(db as unknown as Db, new FakeStripe(), 'pk_test_123')
    const handler = createSetBillingDetailsHandler(stripe)
    await expect(handler(ctx, { country: 'Spain' })).rejects.toThrow(HandlerError)
    await expect(handler(ctx, { country: 'ES', taxId: 'X' })).rejects.toThrow(/taxIdType/)
  })
})
