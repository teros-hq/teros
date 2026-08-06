/**
 * billing.create-setup-intent — start payment-method vaulting for the caller.
 *
 * Returns the SetupIntent client secret + the publishable key the frontend
 * needs to confirm a card with Stripe.js / Elements. User-scoped: a user vaults
 * their OWN payment method (ctx.userId), no admin privileges required.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { StripePaymentService } from '../../../services/stripe-payment-service'
import { StripePaymentError } from '../../../services/_stripe-error'

export function createCreateSetupIntentHandler(
  userService: UserService,
  stripe: StripePaymentService,
) {
  return async function createSetupIntent(ctx: WsHandlerContext) {
    if (!stripe.isEnabled()) {
      throw new HandlerError('STRIPE_NOT_CONFIGURED', 'Card payments are not enabled on this server.')
    }

    const user = await userService.getByUserId(ctx.userId)
    try {
      const { setupIntentId, clientSecret } = await stripe.createSetupIntent(ctx.userId, {
        email: user?.profile?.email,
        name: user?.profile?.displayName,
      })
      return {
        setupIntentId,
        clientSecret,
        publishableKey: stripe.getPublishableKey(),
      }
    } catch (err) {
      if (err instanceof StripePaymentError) {
        throw new HandlerError(err.issue.code, err.issue.message)
      }
      throw err
    }
  }
}
