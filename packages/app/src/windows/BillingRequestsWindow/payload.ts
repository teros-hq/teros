/**
 * Pure payload builders for the billing admin queue (FASE 6). Kept out of the
 * *WindowContent module so they are unit-testable: the render harness stubs every
 * `*WindowContent` import to a no-op, but plain helpers go through untouched. The
 * resolve payload is the high-risk contract (wrong action/hours → wrong admin
 * grant), so it lives here and is tested directly.
 */

export type RequestStatus = 'pending' | 'approved' | 'denied'

export interface AccessRequestSummary {
  _id: string
  type: 'boost' | 'upgrade'
  requestedHours: number | null
}

/** The requester's live billing context attached by admin.list-access-requests (A1). */
export interface RequesterContext {
  currentPlanName: string | null
  agentHoursUsed: number | null
  agentHoursLimit: number | null
  usagePct: number | null
  estimatedCost: number | null
  estimatedCostCurrency: string
}

/**
 * Compact one-line context for the queue: "Pro · 70/80h · 88%". null when the
 * requester has no active-sub context to show (so the row renders nothing rather
 * than an empty separator). Unmetered plans (limit 0) show hours without a %.
 */
export function formatRequesterContext(c: RequesterContext): string | null {
  const parts: string[] = []
  if (c.currentPlanName) parts.push(c.currentPlanName)
  if (c.agentHoursLimit !== null && c.agentHoursUsed !== null) {
    parts.push(c.agentHoursLimit > 0 ? `${c.agentHoursUsed}/${c.agentHoursLimit}h` : `${c.agentHoursUsed}h`)
  }
  if (c.usagePct !== null) parts.push(`${c.usagePct}%`)
  return parts.length ? parts.join(' · ') : null
}

/**
 * Market value of granting a boost ("≈ 60 EUR"), or null when no boost price is
 * configured (so the admin never sees a "≈ null" label). The grant itself is
 * free; this is informational context only.
 */
export function formatEstimatedCost(amount: number | null, currency: string): string | null {
  return amount === null ? null : `≈ ${amount} ${currency}`
}

export interface ResolvePayload {
  requestId: string
  action: 'approve' | 'deny'
  grantedHours?: number
  note?: string
}

/**
 * Build the admin.resolve-access-request payload.
 *
 * - grantedHours is attached ONLY for an approved boost (deny and upgrade carry
 *   none); it defaults to the user's requestedHours, overridable by the admin's
 *   input, floored to an integer.
 * - an empty/whitespace note is omitted (not sent as '').
 */
export function buildResolvePayload(
  req: AccessRequestSummary,
  action: 'approve' | 'deny',
  grantHoursInput: string | undefined,
  noteInput: string | undefined,
): ResolvePayload {
  const payload: ResolvePayload = { requestId: req._id, action }

  const trimmedNote = (noteInput ?? '').trim()
  if (trimmedNote !== '') payload.note = trimmedNote

  if (action === 'approve' && req.type === 'boost') {
    const parsed =
      grantHoursInput != null && grantHoursInput !== ''
        ? Number(grantHoursInput)
        : req.requestedHours
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
      payload.grantedHours = Math.floor(parsed)
    }
  }

  return payload
}
