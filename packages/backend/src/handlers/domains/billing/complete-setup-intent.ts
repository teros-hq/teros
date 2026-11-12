/**
 * billing.complete-setup-intent — finish card vaulting after a redirect.
 *
 * When the bank requires authentication (3DS / SCA, the norm in the EU),
 * Stripe.js redirects away and comes back to `return_url` with
 * `setup_intent=<id>&redirect_status=succeeded`. The inline path never ran, so
 * the frontend calls this with the id: the backend reads the intent back from
 * Stripe (never trusting the URL), checks it belongs to the caller and
 * succeeded, stores the payment method as the default and switches the active
 * subscription to Stripe — exactly what set-payment-method does inline.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import { StripePaymentError } from '../../../services/_stripe-error'
import { markActiveSubscriptionStripe } from '../../../services/billing-subscription-ops.js'

interface CompleteSetupIntentData {
  setupIntentId?: string
}

const SETUP_INTENT_ID_RE = /^seti_[A-Za-z0-9]+$/

export function createCompleteSetupIntentHandler(stripe: StripePaymentService, db: Db) {
  return async function completeSetupIntent(ctx: WsHandlerContext, rawData: unknown) {
    if (!stripe.isEnabled()) {
      throw new HandlerError('STRIPE_NOT_CONFIGURED', 'Card payments are not enabled on this server.')
    }
    const { setupIntentId } = (rawData ?? {}) as CompleteSetupIntentData
    if (typeof setupIntentId !== 'string' || !SETUP_INTENT_ID_RE.test(setupIntentId)) {
      throw new HandlerError('MISSING_FIELDS', 'setupIntentId (seti_…) is required')
    }
    try {
      const customer = await stripe.completeSetupIntent(ctx.userId, setupIntentId)
      const subscriptionSwitched = await markActiveSubscriptionStripe(db, ctx.userId, new Date())
      return { ok: true, defaultPaymentMethodId: customer.defaultPaymentMethodId, subscriptionSwitched }
    } catch (err) {
      if (err instanceof StripePaymentError) {
        throw new HandlerError(err.issue.code, err.issue.message)
      }
      throw err
    }
  }
}
