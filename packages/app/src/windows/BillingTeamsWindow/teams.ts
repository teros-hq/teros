/**
 * Pure derivations for the billing teams window (TER-596 T1). Kept out of the
 * *WindowContent module so they are unit-testable: the render harness stubs every
 * `*WindowContent` import to a no-op, but plain helpers go through untouched (same
 * pattern as BillingRequestsWindow/payload.ts + BillingAuditWindow/audit.ts).
 *
 * The high-risk piece is buildTeamSettingsPayload — a wrong field there mutates
 * the wrong team setting (e.g. clobbering the negotiated seat-price override), so
 * it lives here and is tested directly.
 */

import { colors as semanticColors } from "../../components/mca/primitives/colors"
import type { TeamMember } from "../../services/AdminApi"

/**
 * Filter a roster by a free-text query over name / email / userId
 * (case-insensitive). Empty query returns everyone. Enables the search box to
 * scale past 10+ members.
 */
export function filterMembers(members: TeamMember[], query: string): TeamMember[] {
  const q = query.trim().toLowerCase()
  if (q === "") return members
  return members.filter((m) =>
    [m.userName, m.userEmail, m.userId].some((f) => (f ?? "").toLowerCase().includes(q)),
  )
}

/** Usage color: indigo under 80%, amber 80–99%, red at/over 100%. null → text3. */
export function usageColor(pct: number | null): string {
  if (pct === null) return semanticColors.text3
  if (pct >= 100) return semanticColors.red
  if (pct >= 80) return semanticColors.amber
  return semanticColors.indigo
}

/** "70/80h" when metered, "70h" when unmetered (limit 0), "—" without a sub. */
export function memberHoursLabel(used: number | null, limit: number | null): string {
  if (used === null || limit === null) return "—"
  return limit > 0 ? `${used}/${limit}h` : `${used}h`
}

export interface TeamSettingsForm {
  planId: string
  /** Raw input: "" clears the override (back to plan price); else parsed as number. */
  customSeatPrice: string
  maxSeats: string
  status: "active" | "paused" | "cancelled"
}

export interface TeamSettingsOriginal {
  planId: string
  customSeatPrice: number | null
  maxSeats: number
  status: "active" | "paused" | "cancelled"
}

/** Seed the editable form from a team. customSeatPrice null → "" (empty field). */
export function teamToForm(t: TeamSettingsOriginal): TeamSettingsForm {
  return {
    planId: t.planId,
    customSeatPrice: t.customSeatPrice != null ? String(t.customSeatPrice) : "",
    maxSeats: String(t.maxSeats),
    status: t.status,
  }
}

/** Extract the four editable fields from a team for change comparison. */
export function teamToOriginal(t: TeamSettingsOriginal): TeamSettingsOriginal {
  return {
    planId: t.planId,
    customSeatPrice: t.customSeatPrice,
    maxSeats: t.maxSeats,
    status: t.status,
  }
}

export interface TeamSettingsPayload {
  teamId: string
  planId?: string
  customSeatPrice?: number | null
  maxSeats?: number
  status?: "active" | "paused" | "cancelled"
}

/**
 * Build the admin.update-billing-team payload from the settings form, including
 * ONLY the fields that actually changed (so an unchanged plan never triggers a
 * plan-change, and an untouched override is never clobbered).
 *
 * customSeatPrice: "" → null (clear the override); a finite >= 0 number → that
 * number; anything else (NaN, negative) is treated as "no change" and omitted,
 * so junk input never reaches the handler as a clobbering value.
 */
export function buildTeamSettingsPayload(
  teamId: string,
  form: TeamSettingsForm,
  original: TeamSettingsOriginal,
): TeamSettingsPayload {
  const payload: TeamSettingsPayload = { teamId }

  if (form.planId && form.planId !== original.planId) payload.planId = form.planId

  const rawSeat = form.customSeatPrice.trim()
  let nextSeat: number | null | undefined
  if (rawSeat === "") {
    nextSeat = null
  } else {
    const n = Number(rawSeat)
    nextSeat = Number.isFinite(n) && n >= 0 ? n : undefined
  }
  if (nextSeat !== undefined && nextSeat !== original.customSeatPrice) {
    payload.customSeatPrice = nextSeat
  }

  const maxSeats = Number(form.maxSeats)
  if (Number.isFinite(maxSeats) && maxSeats >= 1 && maxSeats !== original.maxSeats) {
    payload.maxSeats = Math.floor(maxSeats)
  }

  if (form.status !== original.status) payload.status = form.status

  return payload
}
