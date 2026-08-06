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

    expect(res).toEqual({ ok: true, defaultPaymentMethodId: 'pm_abc' })
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
