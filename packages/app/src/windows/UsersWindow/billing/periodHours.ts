/**
 * periodHours — pure, DOM-free helpers for the temporary period hour-boost card.
 *
 * The parse/validate/preview/idempotency logic lives here (not inside the
 * component) so it is cheap to mutation-test and there is ONE place that decides
 * what a valid grant is and what the live preview shows. A boost is temporary:
 * it adds hours to the CURRENT period's effective limit only — it never touches
 * the permanent `customAgentHoursLimit`.
 */

import type { BadgeVariant } from "../../../components/mca/primitives"
import type { BillingAuditBoost } from "../../../services/AdminApi"

/** Backend accepts an integer in [1, 10000]; validate the SAME bounds client-side. */
export const HOURS_MIN = 1
export const HOURS_MAX = 10000

/**
 * The period's effective limit AFTER adding `hours` extra. Pure addition — this
 * is the "→" side of the grant preview and the revoke consequence. Non-finite
 * inputs (mid-typing) coerce to 0 so the preview never renders "NaN".
 */
export function newPeriodLimit(effectiveLimit: number, hours: number): number {
  const base = Number.isFinite(effectiveLimit) ? effectiveLimit : 0
  const add = Number.isFinite(hours) ? hours : 0
  return base + add
}

export type HoursValidation = { ok: true; hours: number } | { ok: false }

/**
 * Validate the raw hours input at the boundary BEFORE the grant fires: a whole
 * number in [HOURS_MIN, HOURS_MAX]. Empty / fractional / out-of-range / NaN all
 * fail (mirrors the backend so the Confirm button can block invalid grants).
 */
export function validateHours(raw: string): HoursValidation {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: false }
  const n = Number(trimmed)
  if (!Number.isInteger(n)) return { ok: false }
  if (n < HOURS_MIN || n > HOURS_MAX) return { ok: false }
  return { ok: true, hours: n }
}

let _fallbackCounter = 0

/**
 * A fresh idempotency nonce for one grant attempt (1-128 chars of [A-Za-z0-9_-]).
 * Prefers `crypto.randomUUID` (guarded for RN-web where it may be absent); falls
 * back to a timestamp+counter that is still unique per call. The COMPONENT calls
 * this ONCE per opened dialog so a double-click on Confirm reuses the same key.
 */
export function makeIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === "function") return c.randomUUID()
  _fallbackCounter += 1
  return `k-${Date.now().toString(36)}-${_fallbackCounter}`
}

export type BoostSource = BillingAuditBoost["source"]

/** Origin badge meta for a boost, keyed by its `source`. */
export function boostOriginMeta(source: BoostSource): { labelKey: string; variant: BadgeVariant } {
  const base = "windows.usersPanel.billing.periodHours.origin"
  switch (source) {
    case "admin_grant":
      return { labelKey: `${base}.grant`, variant: "info" }
    case "purchase":
      return { labelKey: `${base}.purchase`, variant: "success" }
    case "access_request":
      return { labelKey: `${base}.request`, variant: "gray" }
  }
}
