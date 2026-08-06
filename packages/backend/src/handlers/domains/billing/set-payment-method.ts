/**
 * billing.set-payment-method — store the vaulted PM as the caller's default.
 *
 * Called after the frontend confirms a SetupIntent with Stripe.js and obtains a
 * payment_method id. User-scoped (ctx.userId). The charge-cron then bills this
 * PM off-session.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import { StripePaymentError } from '../../../services/_stripe-error'

interface SetPaymentMethodData {
  paymentMethodId?: string
}

export function createSetPaymentMethodHandler(stripe: StripePaymentService) {
  return async function setPaymentMethod(ctx: WsHandlerContext, rawData: unknown) {
    if (!stripe.isEnabled()) {
      throw new HandlerError('STRIPE_NOT_CONFIGURED', 'Card payments are not enabled on this server.')
    }

    const { paymentMethodId } = (rawData ?? {}) as SetPaymentMethodData
    if (typeof paymentMethodId !== 'string' || paymentMethodId.trim() === '') {
      throw new HandlerError('MISSING_FIELDS', 'paymentMethodId is required')
    }

    try {
      const customer = await stripe.setDefaultPaymentMethod(ctx.userId, paymentMethodId)
      return { ok: true, defaultPaymentMethodId: customer.defaultPaymentMethodId }
    } catch (err) {
      if (err instanceof StripePaymentError) {
        throw new HandlerError(err.issue.code, err.issue.message)
      }
      throw err
    }
  }
}
