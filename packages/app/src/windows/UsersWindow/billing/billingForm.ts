/**
 * billingForm — pure, DOM-free helpers for the admin billing edit form.
 *
 * The parse/validate/build logic lives here (not inside the component) so it is
 * cheap to mutation-test and there is ONE place that decides what leaves for
 * `admin.update-billing-subscription`. Fail-loud at the boundary: a non-finite /
 * negative / non-integer number, or a team + per-user override conflict, is
 * rejected BEFORE the request fires (Engineering Principle: DB writes are
 * contracts). The `field` a validation returns maps 1:1 to an i18n error key.
 */

import type { BillingInfo } from "../../../services/AdminApi"

export type SubStatus = "active" | "paused" | "cancelled" | "past_due"

export const SUB_STATUSES: SubStatus[] = ["active", "paused", "cancelled", "past_due"]

export interface BillingFormValues {
  planId: string
  /** Raw text from the input; "" = use the plan default. */
  customPrice: string
  customPriceNote: string
  /** Raw text from the input; "" = use the plan default. */
  customLimit: string
  billingNotes: string
  subStatus: SubStatus
  terosProviderConfigId: string
  teamId: string
}

export type BillingErrorField = "price" | "limit" | "team"

export type BillingValidation =
  | { ok: true; priceNum: number | null; limitNum: number | null }
  | { ok: false; field: BillingErrorField }

/**
 * Validate the raw form values. Returns the parsed numbers on success (null =
 * "use plan default") or the offending field on failure.
 */
export function validateBillingInputs(values: BillingFormValues): BillingValidation {
  const priceNum = values.customPrice.trim() !== "" ? Number(values.customPrice) : null
  if (priceNum !== null && (!Number.isFinite(priceNum) || priceNum < 0)) {
    return { ok: false, field: "price" }
  }

  const limitNum = values.customLimit.trim() !== "" ? Number(values.customLimit) : null
  if (
    limitNum !== null &&
    (!Number.isFinite(limitNum) || limitNum < 0 || !Number.isInteger(limitNum))
  ) {
    return { ok: false, field: "limit" }
  }

  // Mutex: a team member draws plan + hours from the shared team pool, so a
  // per-user custom price/limit would silently contradict it — reject upfront.
  if (values.teamId.trim() !== "" && (priceNum !== null || limitNum !== null)) {
    return { ok: false, field: "team" }
  }

  return { ok: true, priceNum, limitNum }
}

export interface UpdateBillingParams {
  targetUserId: string
  planId?: string
  customPrice?: number | null
  customPriceNote?: string | null
  customAgentHoursLimit?: number | null
  billingNotes?: string
  status?: SubStatus
  terosProviderConfigId?: string | null
  teamId?: string | null
}

/**
 * Build the exact `admin.update-billing-subscription` payload from validated
 * values. `planId`/`status` are only sent when they actually changed (so an
 * unrelated save doesn't re-assert them); the rest send null to clear.
 */
export function buildUpdateParams(
  targetUserId: string,
  values: BillingFormValues,
  priceNum: number | null,
  limitNum: number | null,
  original: Pick<BillingInfo, "planId" | "status">,
): UpdateBillingParams {
  return {
    targetUserId,
    planId: values.planId !== original.planId ? values.planId : undefined,
    customPrice: priceNum,
    customPriceNote: values.customPriceNote.trim() || null,
    customAgentHoursLimit: limitNum,
    billingNotes: values.billingNotes.trim() || undefined,
    status: values.subStatus !== original.status ? values.subStatus : undefined,
    terosProviderConfigId:
      values.terosProviderConfigId.trim() !== "" ? values.terosProviderConfigId : null,
    teamId: values.teamId.trim() !== "" ? values.teamId : null,
  }
}
