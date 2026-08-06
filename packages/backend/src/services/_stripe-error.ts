/**
 * Stripe error classifier (FASE 4).
 *
 * Maps a thrown Stripe error to a typed {@link StripeIssue} the charge-cron and
 * handlers branch on, WITHOUT importing the SDK error classes — it reads the
 * stable `type` / `code` / `decline_code` fields present on every StripeError.
 * Same shape as the MCA OAuth classifiers (`_<provider>-error.ts`): the upstream
 * `message` is preserved verbatim; only the code/category/retry decision is ours.
 *
 * `category` drives dunning policy:
 *   - card      → a payment-method problem the user can fix; dunning retries
 *                 (within the grace window) and the failure is shown to the user.
 *   - transient → rate limit / network blip; retry.
 *   - config    → our Stripe key/permissions are broken; DO NOT keep charging,
 *                 alert ops (the user isn't at fault).
 *   - integrity → the amount Stripe would charge diverges from the quote (a swept
 *                 customer balance, unexpected tax). Like config, it is OUR fault,
 *                 not the user's: DO NOT dun and DO NOT block the account — surface
 *                 to ops and hold the invoice. The charge is refused before the
 *                 card is touched (the invoice is voided).
 *   - request   → a malformed request = a bug; not retryable.
 *   - unknown   → unrecognized; retry within grace (bounded), surface for review.
 */

export type StripeIssueCategory =
  | 'card'
  | 'transient'
  | 'config'
  | 'integrity'
  | 'request'
  | 'unknown'

export interface StripeIssue {
  /** Stable, branchable code (e.g. CARD_DECLINED, RATE_LIMITED). */
  code: string
  category: StripeIssueCategory
  /** Whether the charge-cron may retry this charge later (within grace). */
  retryable: boolean
  /** Upstream Stripe message, preserved verbatim. */
  message: string
  /** Stripe decline_code when present (card errors). */
  declineCode?: string
}

interface RawStripeError {
  type?: string
  code?: string
  decline_code?: string
  message?: string
}

/** Code raised by our own service when a Stripe charge is attempted with no PM. */
export const NO_PAYMENT_METHOD = 'NO_PAYMENT_METHOD'

/**
 * Code raised by the charge guard when the amount Stripe would collect diverges
 * from the quoted amount (swept customer balance / unexpected tax). Category
 * 'integrity': no dunning, no account block — surfaced to ops, invoice held.
 */
export const AMOUNT_MISMATCH = 'AMOUNT_MISMATCH'

function classifyCardDecline(declineCode: string | undefined): string {
  switch (declineCode) {
    case 'authentication_required':
      return 'AUTH_REQUIRED'
    case 'insufficient_funds':
      return 'INSUFFICIENT_FUNDS'
    case 'expired_card':
      return 'EXPIRED_CARD'
    default:
      return 'CARD_DECLINED'
  }
}

/**
 * A classified Stripe failure. The message is prefixed with `[CODE]` (same
 * workaround as the MCA OAuth errors) so a consumer that only sees `.message`
 * can still branch, and `.issue` carries the full classification for callers
 * that need the category/retryable decision (the charge-cron dunning logic).
 */
export class StripePaymentError extends Error {
  constructor(public readonly issue: StripeIssue) {
    super(`[${issue.code}] ${issue.message}`)
    this.name = 'StripePaymentError'
  }
}

export function classifyStripeError(err: unknown): StripeIssue {
  // Already classified upstream — don't re-wrap (would lose decline_code etc.).
  if (err instanceof StripePaymentError) return err.issue

  const e = (err ?? {}) as RawStripeError
  const message =
    typeof e.message === 'string' && e.message.length > 0 ? e.message : 'Unknown Stripe error'

  switch (e.type) {
    case 'StripeCardError':
      return {
        code: classifyCardDecline(e.decline_code),
        category: 'card',
        retryable: true,
        message,
        declineCode: e.decline_code,
      }
    case 'StripeRateLimitError':
      return { code: 'RATE_LIMITED', category: 'transient', retryable: true, message }
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return { code: 'API_UNAVAILABLE', category: 'transient', retryable: true, message }
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return { code: 'CONFIG_ERROR', category: 'config', retryable: false, message }
    case 'StripeInvalidRequestError':
      return { code: 'INVALID_REQUEST', category: 'request', retryable: false, message }
    case 'StripeIdempotencyError':
      return { code: 'IDEMPOTENCY_ERROR', category: 'request', retryable: false, message }
    default:
      return { code: 'UNKNOWN', category: 'unknown', retryable: true, message }
  }
}
