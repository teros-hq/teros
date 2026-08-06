import { describe, expect, it } from "bun:test"
import {
  cleanOptionalString,
  validateDate,
  validateDateRange,
  validateId,
  validateMinutes,
  validateNonEmptyString,
} from "../../src/tools/_runn-helpers"

describe("validateId (numeric Runn ids)", () => {
  it("accepts positive integers and returns them", () => {
    expect(validateId(1, "x")).toBe(1)
    expect(validateId(987654, "x")).toBe(987654)
  })

  it("rejects zero, negatives, non-integers, strings, null", () => {
    expect(() => validateId(0, "projectId")).toThrow(/projectId/)
    expect(() => validateId(-1, "x")).toThrow()
    expect(() => validateId(1.5, "x")).toThrow()
    expect(() => validateId("5", "x")).toThrow() // v1 ids are numeric, not strings
    expect(() => validateId(null, "x")).toThrow()
    expect(() => validateId(undefined, "x")).toThrow()
    expect(() => validateId(Number.NaN, "x")).toThrow()
  })
})

describe("validateDate (YYYY-MM-DD, real calendar date)", () => {
  it("accepts a real date", () => {
    expect(validateDate("2026-06-30", "startDate")).toBe("2026-06-30")
    expect(validateDate("2024-02-29", "d")).toBe("2024-02-29") // leap year
  })

  it("rejects wrong format", () => {
    expect(() => validateDate("2026-6-30", "d")).toThrow()
    expect(() => validateDate("30-06-2026", "d")).toThrow()
    expect(() => validateDate("2026/06/30", "d")).toThrow()
    expect(() => validateDate("", "d")).toThrow()
    expect(() => validateDate(20260630 as unknown, "d")).toThrow()
  })

  it("rejects impossible calendar dates", () => {
    expect(() => validateDate("2026-13-01", "d")).toThrow(/real calendar date/)
    expect(() => validateDate("2026-02-30", "d")).toThrow(/real calendar date/)
    expect(() => validateDate("2025-02-29", "d")).toThrow(/real calendar date/) // not a leap year
    expect(() => validateDate("2026-00-10", "d")).toThrow()
  })
})

describe("validateMinutes", () => {
  it("accepts non-negative integers", () => {
    expect(validateMinutes(0, "m")).toBe(0)
    expect(validateMinutes(480, "m")).toBe(480)
  })
  it("rejects negatives, fractions, strings", () => {
    expect(() => validateMinutes(-1, "m")).toThrow()
    expect(() => validateMinutes(1.5, "m")).toThrow()
    expect(() => validateMinutes("60", "m")).toThrow()
  })
})

describe("validateDateRange", () => {
  it("passes when end >= start", () => {
    expect(() => validateDateRange("2026-01-01", "2026-12-31")).not.toThrow()
    expect(() => validateDateRange("2026-05-05", "2026-05-05")).not.toThrow()
  })
  it("throws when end < start", () => {
    expect(() => validateDateRange("2026-12-31", "2026-01-01")).toThrow(/on or after/)
  })
})

describe("cleanOptionalString", () => {
  it("trims and returns non-empty strings", () => {
    expect(cleanOptionalString("  hello ")).toBe("hello")
    expect(cleanOptionalString("a")).toBe("a")
  })
  it("returns undefined for empty/whitespace/non-strings", () => {
    expect(cleanOptionalString("")).toBeUndefined()
    expect(cleanOptionalString("   ")).toBeUndefined()
    expect(cleanOptionalString(42)).toBeUndefined()
    expect(cleanOptionalString(null)).toBeUndefined()
    expect(cleanOptionalString(undefined)).toBeUndefined()
  })
})

describe("validateNonEmptyString", () => {
  it("returns the trimmed value", () => {
    expect(validateNonEmptyString("  Acme ", "name")).toBe("Acme")
  })
  it("throws on empty/whitespace", () => {
    expect(() => validateNonEmptyString("", "name")).toThrow(/name/)
    expect(() => validateNonEmptyString("   ", "name")).toThrow(/name/)
  })
})
