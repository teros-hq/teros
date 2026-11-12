import { describe, expect, it } from "vitest"
import { codeFromInput, passwordRules } from "./passwordRules"

describe("password reset rules", () => {
  it("[PWR-AC-7] codeFromInput keeps the first six digits of typed or pasted text", () => {
    expect(codeFromInput("12 34-56 78")).toBe("123456")
    expect(codeFromInput("12a")).toBe("12")
    expect(codeFromInput("Your code: 420850")).toBe("420850")
    expect(codeFromInput("")).toBe("")
  })

  it("[PWR-AC-8] a 7-character password fails the length rule and shows its count", () => {
    expect(passwordRules("testing", "")).toEqual({
      length: 7,
      minLength: "failed",
      match: "pending",
      canSubmit: false,
    })
  })

  it("[PWR-AC-8] both rules met enable submit", () => {
    expect(passwordRules("testing1", "testing1")).toEqual({
      length: 8,
      minLength: "met",
      match: "met",
      canSubmit: true,
    })
  })

  it("[PWR-AC-8] a different confirmation fails the match rule", () => {
    const rules = passwordRules("testing1", "testing2")
    expect(rules.match).toBe("failed")
    expect(rules.canSubmit).toBe(false)
  })

  it("nothing typed yet is pending, not failed", () => {
    expect(passwordRules("", "")).toEqual({
      length: 0,
      minLength: "pending",
      match: "pending",
      canSubmit: false,
    })
  })
})
