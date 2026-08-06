/**
 * billingForm — pure validation + payload building. Assertions that BITE:
 *   - a negative / non-finite / non-integer number is rejected on the RIGHT
 *     field (mutation: relaxing `< 0` to `<= 0` fails the "0 is valid" case;
 *     dropping `Number.isInteger` fails the "1.5 is rejected" case),
 *   - the team↔override mutex rejects a custom price/limit + team together,
 *   - `buildUpdateParams` emits the EXACT payload: unchanged plan/status are
 *     omitted (undefined), empty strings become null, so a no-op save doesn't
 *     re-assert the plan.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/billing/billingForm.render.test.ts
 */
import { describe, expect, it } from "vitest"
import { type BillingFormValues, buildUpdateParams, validateBillingInputs } from "./billingForm"

function values(over: Partial<BillingFormValues> = {}): BillingFormValues {
  return {
    planId: "plan_growth",
    customPrice: "",
    customPriceNote: "",
    customLimit: "",
    billingNotes: "",
    subStatus: "active",
    terosProviderConfigId: "",
    teamId: "",
    ...over,
  }
}

describe("validateBillingInputs", () => {
  it("accepts empty inputs → null numbers (use plan default)", () => {
    expect(validateBillingInputs(values())).toEqual({ ok: true, priceNum: null, limitNum: null })
  })

  it("accepts 0 as a valid price and limit (boundary)", () => {
    expect(validateBillingInputs(values({ customPrice: "0", customLimit: "0" }))).toEqual({
      ok: true,
      priceNum: 0,
      limitNum: 0,
    })
  })

  it("accepts a finite positive price + whole-number limit", () => {
    expect(validateBillingInputs(values({ customPrice: "89", customLimit: "80" }))).toEqual({
      ok: true,
      priceNum: 89,
      limitNum: 80,
    })
  })

  it("rejects a negative price on the price field", () => {
    expect(validateBillingInputs(values({ customPrice: "-5" }))).toEqual({
      ok: false,
      field: "price",
    })
  })

  it("rejects a non-numeric price on the price field", () => {
    expect(validateBillingInputs(values({ customPrice: "abc" }))).toEqual({
      ok: false,
      field: "price",
    })
  })

  it("rejects a fractional limit on the limit field", () => {
    expect(validateBillingInputs(values({ customLimit: "1.5" }))).toEqual({
      ok: false,
      field: "limit",
    })
  })

  it("rejects a negative limit on the limit field", () => {
    expect(validateBillingInputs(values({ customLimit: "-2" }))).toEqual({
      ok: false,
      field: "limit",
    })
  })

  it("rejects a team + custom price/limit together (mutex)", () => {
    expect(validateBillingInputs(values({ teamId: "team_1", customPrice: "50" }))).toEqual({
      ok: false,
      field: "team",
    })
    expect(validateBillingInputs(values({ teamId: "team_1", customLimit: "10" }))).toEqual({
      ok: false,
      field: "team",
    })
  })

  it("allows a team on its own (no custom override)", () => {
    expect(validateBillingInputs(values({ teamId: "team_1" }))).toEqual({
      ok: true,
      priceNum: null,
      limitNum: null,
    })
  })
})

describe("buildUpdateParams", () => {
  const original = { planId: "plan_growth", status: "active" as const }

  it("omits unchanged plan/status and nulls empty strings (no-op save)", () => {
    expect(buildUpdateParams("user_1", values(), null, null, original)).toEqual({
      targetUserId: "user_1",
      planId: undefined,
      customPrice: null,
      customPriceNote: null,
      customAgentHoursLimit: null,
      billingNotes: undefined,
      status: undefined,
      terosProviderConfigId: null,
      teamId: null,
    })
  })

  it("sends plan/status only when they changed, and forwards parsed numbers + ids", () => {
    const v = values({
      planId: "plan_unlimited",
      subStatus: "paused",
      customPriceNote: "Partner",
      billingNotes: "internal",
      terosProviderConfigId: "cfg_1",
      teamId: "team_1",
    })
    expect(buildUpdateParams("user_1", v, 120, 500, original)).toEqual({
      targetUserId: "user_1",
      planId: "plan_unlimited",
      customPrice: 120,
      customPriceNote: "Partner",
      customAgentHoursLimit: 500,
      billingNotes: "internal",
      status: "paused",
      terosProviderConfigId: "cfg_1",
      teamId: "team_1",
    })
  })
})
