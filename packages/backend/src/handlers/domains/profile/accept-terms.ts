/**
 * profile.accept-terms — Accept Terms of Service
 *
 * Sets termsAcceptedAt on the user document.
 * Called once from the Welcome/onboarding screen.
 */

import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { UserService } from '../../../auth/user-service'

interface AcceptTermsResult {
  termsAcceptedAt: string
}

export function createAcceptTermsHandler(userService: UserService) {
  return async function acceptTerms(ctx: WsHandlerContext): Promise<AcceptTermsResult> {
    const updated = await userService.acceptTerms(ctx.userId)

    if (!updated) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      termsAcceptedAt: updated.termsAcceptedAt!.toISOString(),
    }
  }
}
