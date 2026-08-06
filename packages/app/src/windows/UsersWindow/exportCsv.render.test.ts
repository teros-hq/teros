/**
 * exportCsv — the PURE billing CSV builder. Assertion that BITES: exact bytes
 * for a known input, including RFC-4180 quote-doubling and the ISO→date slice.
 * A mutation (drop the quote escaping, or the `slice(0,10)`) changes the string.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/exportCsv.render.test.ts
 */
import { describe, expect, it } from "vitest"
import { buildBillingCsv } from "./exportCsv"

describe("buildBillingCsv", () => {
  it("builds the exact header + data row (quotes doubled, dates sliced)", () => {
    const csv = buildBillingCsv({
      userId: "user_1",
      email: "nora@x.io",
      planName: "Growth",
      effectivePrice: 89,
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
      billingStatus: "waived",
      billingNotes: 'has "quotes"',
    })
    expect(csv).toBe(
      '"user_id","email","plan","price_effective","period_start","period_end","billing_status","billing_notes"\n' +
        '"user_1","nora@x.io","Growth","89","2026-06-01","2026-07-01","waived","has ""quotes"""',
    )
  })

  it("keeps empty period/notes as empty quoted cells", () => {
    const csv = buildBillingCsv({
      userId: "u",
      email: "",
      planName: "Free",
      effectivePrice: 0,
      periodStart: "",
      periodEnd: "",
      billingStatus: "",
      billingNotes: "",
    })
    expect(csv.split("\n")[1]).toBe('"u","","Free","0","","","",""')
  })
})
