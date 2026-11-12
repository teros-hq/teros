import { describe, expect, it } from "vitest"
import { dark, light } from "./tokens"
import { progressFill } from "./rowFill"

describe("row progress fill (TODORF)", () => {
  it("[TODORF-AC-1] a blocked task fills red, working amber, pending blue, review violet, in both themes", () => {
    for (const td of [light, dark]) {
      expect(progressFill(td, "blocked")).toBe(td.progBlocked)
      expect(progressFill(td, "working")).toBe(td.progWorking)
      expect(progressFill(td, "pending")).toBe(td.progPending)
      expect(progressFill(td, "review")).toBe(td.progRev)
      expect(td.progBlocked).toMatch(/^rgba\(239,68,68,/)
    }
  })
})
