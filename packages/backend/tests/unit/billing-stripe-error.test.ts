/**
 * Stripe error classifier (FASE 4a).
 *
 * classifyStripeError maps a thrown Stripe error to a typed StripeIssue that the
 * charge-cron and handlers branch on. The classification drives dunning policy
 * (retry vs alert-ops vs surface-to-user), so a wrong code is a money bug:
 * misreading a config error as a card decline would silently dun a blameless
 * user; misreading a transient blip as terminal would drop a collectible
 * invoice.
 *
 * Asserts the EXACT StripeIssue for each branch (toEqual, full shape). The
 * decline_code sub-classification and the unknown fallback each have their own
 * case so a collapsed switch arm shows up red.
 *
 * MUST BITE — confirmed against mutants:
 *   - flip CONFIG_ERROR.retryable false→true → config test red.
 *   - drop the decline_code switch (always CARD_DECLINED) → the 3 sub-code
 *     tests red.
 *   - fold StripeRateLimitError into the default arm → transient test red.
 */

import { describe, expect, it } from 'bun:test'
import { classifyStripeError } from '../../src/services/_stripe-error'

describe('classifyStripeError', () => {
  it('classifies a generic card decline', () => {
    const issue = classifyStripeError({
      type: 'StripeCardError',
      code: 'card_declined',
      decline_code: 'do_not_honor',
      message: 'Your card was declined.',
    })
    expect(issue).toEqual({
      code: 'CARD_DECLINED',
      category: 'card',
      retryable: true,
      message: 'Your card was declined.',
      declineCode: 'do_not_honor',
    })
  })

  it('classifies authentication_required as AUTH_REQUIRED', () => {
    const issue = classifyStripeError({
      type: 'StripeCardError',
      decline_code: 'authentication_required',
      message: 'This payment requires authentication.',
    })
    expect(issue).toEqual({
      code: 'AUTH_REQUIRED',
      category: 'card',
      retryable: true,
      message: 'This payment requires authentication.',
      declineCode: 'authentication_required',
    })
  })

  it('classifies insufficient_funds', () => {
    const issue = classifyStripeError({
      type: 'StripeCardError',
      decline_code: 'insufficient_funds',
      message: 'Insufficient funds.',
    })
    expect(issue).toEqual({
      code: 'INSUFFICIENT_FUNDS',
      category: 'card',
      retryable: true,
      message: 'Insufficient funds.',
      declineCode: 'insufficient_funds',
    })
  })

  it('classifies expired_card', () => {
    const issue = classifyStripeError({
      type: 'StripeCardError',
      decline_code: 'expired_card',
      message: 'Your card has expired.',
    })
    expect(issue).toEqual({
      code: 'EXPIRED_CARD',
      category: 'card',
      retryable: true,
      message: 'Your card has expired.',
      declineCode: 'expired_card',
    })
  })

  it('classifies a rate-limit error as transient + retryable', () => {
    const issue = classifyStripeError({
      type: 'StripeRateLimitError',
      message: 'Too many requests.',
    })
    expect(issue).toEqual({
      code: 'RATE_LIMITED',
      category: 'transient',
      retryable: true,
      message: 'Too many requests.',
    })
  })

  it('classifies a connection error as transient API_UNAVAILABLE', () => {
    const issue = classifyStripeError({
      type: 'StripeConnectionError',
      message: 'Network error.',
    })
    expect(issue).toEqual({
      code: 'API_UNAVAILABLE',
      category: 'transient',
      retryable: true,
      message: 'Network error.',
    })
  })

  it('classifies an authentication error as a non-retryable CONFIG_ERROR', () => {
    // A bad API key is OUR fault — must NOT be retried as a charge (would dun a
    // blameless user); category 'config' routes it to ops alerting instead.
    const issue = classifyStripeError({
      type: 'StripeAuthenticationError',
      message: 'Invalid API Key provided.',
    })
    expect(issue).toEqual({
      code: 'CONFIG_ERROR',
      category: 'config',
      retryable: false,
      message: 'Invalid API Key provided.',
    })
  })

  it('classifies an invalid-request error as a non-retryable request bug', () => {
    const issue = classifyStripeError({
      type: 'StripeInvalidRequestError',
      message: 'No such customer.',
    })
    expect(issue).toEqual({
      code: 'INVALID_REQUEST',
      category: 'request',
      retryable: false,
      message: 'No such customer.',
    })
  })

  it('classifies an idempotency error as a non-retryable request bug', () => {
    const issue = classifyStripeError({
      type: 'StripeIdempotencyError',
      message: 'Keys for idempotent requests can only be used once.',
    })
    expect(issue).toEqual({
      code: 'IDEMPOTENCY_ERROR',
      category: 'request',
      retryable: false,
      message: 'Keys for idempotent requests can only be used once.',
    })
  })

  it('falls back to UNKNOWN for an unrecognized error type', () => {
    const issue = classifyStripeError({
      type: 'StripeBrandNewError',
      message: 'Something new.',
    })
    expect(issue).toEqual({
      code: 'UNKNOWN',
      category: 'unknown',
      retryable: true,
      message: 'Something new.',
    })
  })

  it('preserves a default message when none is provided and handles non-objects', () => {
    expect(classifyStripeError(null)).toEqual({
      code: 'UNKNOWN',
      category: 'unknown',
      retryable: true,
      message: 'Unknown Stripe error',
    })
    expect(classifyStripeError({ type: 'StripeCardError', decline_code: 'generic_decline' })).toEqual({
      code: 'CARD_DECLINED',
      category: 'card',
      retryable: true,
      message: 'Unknown Stripe error',
      declineCode: 'generic_decline',
    })
  })
})
