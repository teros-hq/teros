/**
 * profile.complete-onboarding — Mark onboarding as completed
 *
 * Sets onboardingCompletedAt on the user document.
 * Called from the final step of the onboarding wizard.
 */

import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { UserService } from '../../../auth/user-service'

interface CompleteOnboardingResult {
  onboardingCompletedAt: string
}

export function createCompleteOnboardingHandler(userService: UserService) {
  return async function completeOnboarding(ctx: WsHandlerContext): Promise<CompleteOnboardingResult> {
    const updated = await userService.completeOnboarding(ctx.userId)

    if (!updated) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      onboardingCompletedAt: updated.onboardingCompletedAt!.toISOString(),
    }
  }
}
