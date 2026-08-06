/**
 * buildResolvePayload (FASE 6) — the admin.resolve-access-request contract. This
 * is the high-risk piece (a wrong action/hours mis-resolves a billing request),
 * so each assertion targets a mutation:
 *   - approved boost defaults grantedHours to requestedHours,
 *   - an admin override wins and is floored,
 *   - deny carries NO grantedHours (even for a boost),
 *   - an approved UPGRADE carries no grantedHours,
 *   - an empty/whitespace note is omitted; a real note is trimmed in.
 *
 * The full window render is covered by the live smoke (the harness stubs every
 * *WindowContent module by design), but the payload logic bites here.
 *
 *   cd packages/app && npx vitest run src/windows/BillingRequestsWindow/payload.render.test.ts
 */
import { describe, expect, it } from 'vitest'
import { buildResolvePayload, formatEstimatedCost, formatRequesterContext } from './payload'

const BOOST = { _id: 'req_1', type: 'boost' as const, requestedHours: 10 }
const UPGRADE = { _id: 'req_2', type: 'upgrade' as const, requestedHours: null }

describe('buildResolvePayload', () => {
  it('approved boost defaults grantedHours to the requested hours', () => {
    expect(buildResolvePayload(BOOST, 'approve', undefined, undefined)).toEqual({
      requestId: 'req_1',
      action: 'approve',
      grantedHours: 10,
    })
  })

  it('approved boost uses the admin override, floored to an integer', () => {
    expect(buildResolvePayload(BOOST, 'approve', '25.9', undefined)).toEqual({
      requestId: 'req_1',
      action: 'approve',
      grantedHours: 25,
    })
  })

  it('deny carries no grantedHours even for a boost', () => {
    expect(buildResolvePayload(BOOST, 'deny', '25', undefined)).toEqual({
      requestId: 'req_1',
      action: 'deny',
    })
  })

  it('approved upgrade carries no grantedHours', () => {
    expect(buildResolvePayload(UPGRADE, 'approve', undefined, undefined)).toEqual({
      requestId: 'req_2',
      action: 'approve',
    })
  })

  it('trims a real note in and omits a whitespace-only one', () => {
    expect(buildResolvePayload(BOOST, 'deny', undefined, '  too much  ')).toEqual({
      requestId: 'req_1',
      action: 'deny',
      note: 'too much',
    })
    const blank = buildResolvePayload(BOOST, 'deny', undefined, '   ')
    expect('note' in blank).toBe(false)
  })

  it('drops a non-numeric override and falls through to no grantedHours guard', () => {
    // Number('abc') → NaN → not finite → grantedHours omitted (the input layer
    // strips non-digits, but the helper must not emit NaN regardless).
    const p = buildResolvePayload({ _id: 'r', type: 'boost', requestedHours: null }, 'approve', 'abc', undefined)
    expect('grantedHours' in p).toBe(false)
  })
})

const CTX = (over: Record<string, unknown> = {}) => ({
  currentPlanName: 'Pro' as string | null,
  agentHoursUsed: 70 as number | null,
  agentHoursLimit: 80 as number | null,
  usagePct: 88 as number | null,
  estimatedCost: 60 as number | null,
  estimatedCostCurrency: 'EUR',
  ...over,
})

describe('formatRequesterContext', () => {
  it('joins plan, usage and percent', () => {
    expect(formatRequesterContext(CTX())).toBe('Pro · 70/80h · 88%')
  })

  it('omits the percent and shows raw hours for an unmetered plan (limit 0)', () => {
    expect(formatRequesterContext(CTX({ agentHoursLimit: 0, usagePct: null }))).toBe('Pro · 70h')
  })

  it('returns null when the requester has no active-sub context', () => {
    // MUST BITE: rendering an empty " · · " separator with no data is the bug.
    expect(
      formatRequesterContext(CTX({ currentPlanName: null, agentHoursUsed: null, agentHoursLimit: null, usagePct: null })),
    ).toBeNull()
  })
})

describe('formatEstimatedCost', () => {
  it('formats an amount with its currency', () => {
    expect(formatEstimatedCost(60, 'EUR')).toBe('≈ 60 EUR')
  })

  it('returns null when no boost price is configured', () => {
    // MUST BITE: a "≈ null EUR" label would mislead the admin.
    expect(formatEstimatedCost(null, 'EUR')).toBeNull()
  })
})
