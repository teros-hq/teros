/**
 * Step-up auth guard (Req 2.4.1)
 *
 * Shared helper that sensitive admin handlers call to verify the caller's
 * session has a recent step-up authentication. Throws HandlerError with
 * `STEP_UP_REQUIRED` if the session has not been step-up authenticated
 * within the valid window.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SessionService } from '../../../auth/session-service'
import { hashSessionToken } from '../../../auth/session-service'

/**
 * Assert that the caller's session has valid step-up authentication.
 * Call this at the top of sensitive handlers, after the role check.
 *
 * @throws HandlerError('STEP_UP_REQUIRED') if no valid step-up is present
 */
export async function requireStepUp(
  ctx: WsHandlerContext,
  sessionService: SessionService,
): Promise<void> {
  if (!ctx.sessionToken) {
    throw new HandlerError('STEP_UP_REQUIRED', 'Session token not available — cannot verify step-up')
  }

  const tokenHash = hashSessionToken(ctx.sessionToken)
  const session = await sessionService.getByTokenHash(tokenHash)

  if (!session) {
    throw new HandlerError('STEP_UP_REQUIRED', 'Current session not found')
  }

  if (!sessionService.hasValidStepUp(session)) {
    throw new HandlerError(
      'STEP_UP_REQUIRED',
      'Step-up authentication required. Call admin.verify-step-up to re-authenticate before performing this action.',
    )
  }
}
