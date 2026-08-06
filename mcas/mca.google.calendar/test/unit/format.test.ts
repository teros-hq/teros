import { describe, expect, it } from "bun:test"
import { computeDurationMinutes, describeRecurrence, flattenEventTime } from "../../src/lib/format"

describe("describeRecurrence", () => {
  it("returns null for empty/undefined/null", () => {
    expect(describeRecurrence(undefined)).toBeNull()
    expect(describeRecurrence(null)).toBeNull()
    expect(describeRecurrence([])).toBeNull()
  })

  it("parses weekly with BYDAY", () => {
    const out = describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"])
    expect(out).toBe("Weekly on Mon, Wed, Fri")
  })

  it("parses daily with INTERVAL", () => {
    const out = describeRecurrence(["RRULE:FREQ=DAILY;INTERVAL=2"])
    expect(out).toBe("Every 2 daily")
  })

  it("parses monthly with COUNT", () => {
    const out = describeRecurrence(["RRULE:FREQ=MONTHLY;COUNT=6"])
    expect(out).toBe("Monthly for 6 occurrences")
  })

  it("parses yearly with UNTIL", () => {
    const out = describeRecurrence(["RRULE:FREQ=YEARLY;UNTIL=20301231T235959Z"])
    expect(out).toBe("Yearly until 20301231T235959Z")
  })

  it("joins multiple rules with semicolon", () => {
    const out = describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO", "RRULE:FREQ=YEARLY;BYDAY=TU"])
    expect(out).toBe("Weekly on Mon; Yearly on Tue")
  })

  it("passes through non-RRULE strings (e.g. EXDATE)", () => {
    const out = describeRecurrence(["EXDATE;TZID=Europe/Madrid:20260501T140000"])
    expect(out).toBe("EXDATE;TZID=Europe/Madrid:20260501T140000")
  })
})

describe("computeDurationMinutes", () => {
  it("returns 0 for invalid input", () => {
    expect(computeDurationMinutes("not-a-date", "2026-04-27T10:00:00Z")).toBe(0)
    expect(computeDurationMinutes("2026-04-27T10:00:00Z", "nope")).toBe(0)
  })

  it("returns 0 when end <= start", () => {
    expect(computeDurationMinutes("2026-04-27T10:00:00Z", "2026-04-27T10:00:00Z")).toBe(0)
    expect(computeDurationMinutes("2026-04-27T10:30:00Z", "2026-04-27T10:00:00Z")).toBe(0)
  })

  it("rounds duration to whole minutes", () => {
    expect(computeDurationMinutes("2026-04-27T10:00:00Z", "2026-04-27T10:30:00Z")).toBe(30)
    expect(computeDurationMinutes("2026-04-27T10:00:00Z", "2026-04-27T11:00:00Z")).toBe(60)
    expect(computeDurationMinutes("2026-04-27T10:00:00Z", "2026-04-27T10:00:30Z")).toBe(1)
  })
})

describe("flattenEventTime", () => {
  it("returns null for missing input", () => {
    expect(flattenEventTime(null)).toBeNull()
    expect(flattenEventTime(undefined)).toBeNull()
    expect(flattenEventTime({})).toBeNull()
  })

  it("prefers dateTime over date", () => {
    expect(flattenEventTime({ dateTime: "2026-04-27T10:00:00Z", date: "2026-04-27" })).toBe(
      "2026-04-27T10:00:00Z",
    )
  })

  it("falls back to date for all-day events", () => {
    expect(flattenEventTime({ date: "2026-04-27" })).toBe("2026-04-27")
  })
})
