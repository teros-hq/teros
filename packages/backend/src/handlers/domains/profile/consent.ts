/**
 * profile.set-evaluation-consent — opt-in toggle for anonymized conversation
 * evaluation (task_047a4844b9103db3).
 *
 * Pablo's closed decisions (2026-10-26):
 *   - Opt-in, NOT opt-out: default OFF. Nobody enters the evaluation pipeline
 *     without an explicit toggle.
 *   - Scope: anonymized data (identities protected by the fase-4a anonymizer).
 *     The platform always persists conversations — the consent is about their
 *     use for evaluation/improvement, never about storage. The Profile copy
 *     says exactly this; do not soften it.
 *
 * Self-service only: the flag always applies to ctx.userId (the caller); the
 * action never accepts a target userId. The consent-copy version is stamped
 * server-side — the client cannot claim it agreed to a different copy.
 * Every change is audited in consent_audit_log (UserService).
 *
 * Read path: profile.get returns the current state (consent.evaluationOptIn,
 * default false) — no separate read action needed.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import { toIsoString } from '../../../auth/types'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'

/**
 * Version of the consent copy the user agreed to.
 * Bump when the "Help improve Teros" copy in the Profile (i18n
 * profile.improveTeros.*) materially changes what is being consented to.
 */
export const EVALUATION_CONSENT_VERSION = 'v1'

export interface EvaluationConsentState {
  evaluationOptIn: boolean
  evaluationConsentAt?: string
  evaluationConsentVersion?: string
}

export function createSetEvaluationConsentHandler(userService: UserService) {
  return async function setEvaluationConsent(
    ctx: WsHandlerContext,
    rawData: unknown,
  ): Promise<EvaluationConsentState> {
    const data = (rawData ?? {}) as { evaluationOptIn?: unknown }
    if (typeof data.evaluationOptIn !== 'boolean') {
      throw new HandlerError('BAD_REQUEST', 'evaluationOptIn must be a boolean')
    }

    const updated = await userService.setEvaluationConsent(
      ctx.userId,
      data.evaluationOptIn,
      EVALUATION_CONSENT_VERSION,
    )

    if (!updated) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      evaluationOptIn: updated.consent?.evaluationOptIn ?? false,
      evaluationConsentAt: toIsoString(updated.consent?.evaluationConsentAt),
      evaluationConsentVersion: updated.consent?.evaluationConsentVersion,
    }
  }
}
