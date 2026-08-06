import { describe, expect, it } from "vitest"
import { bucketRange, drillToAgentUsageProps } from "./drill"

const ISOS = ["2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z", "2026-06-01T12:00:00.000Z"]
const VIEW_TO = "2026-06-01T13:00:00.000Z"

describe("bucketRange", () => {
  it("a middle bar spans [bucket, next bucket)", () => {
    expect(bucketRange(ISOS, 1, VIEW_TO)).toEqual({
      from: "2026-06-01T11:00:00.000Z",
      to: "2026-06-01T12:00:00.000Z",
    })
  })

  it("the last bar spans [bucket, view.to) (no next bucket)", () => {
    // Mutation: `isos[index + 1] ?? fallbackTo` → `isos[index + 1]` would give undefined.
    expect(bucketRange(ISOS, 2, VIEW_TO)).toEqual({
      from: "2026-06-01T12:00:00.000Z",
      to: VIEW_TO,
    })
  })

  it("returns null for out-of-range / negative indices", () => {
    expect(bucketRange(ISOS, 3, VIEW_TO)).toBeNull()
    expect(bucketRange(ISOS, -1, VIEW_TO)).toBeNull()
    expect(bucketRange([], 0, VIEW_TO)).toBeNull()
  })
})

describe("drillToAgentUsageProps", () => {
  it("carries the bucket range plus the originating period (A5.4)", () => {
    expect(drillToAgentUsageProps({ from: ISOS[0], to: ISOS[1] }, "7d")).toEqual({
      initialFrom: ISOS[0],
      initialTo: ISOS[1],
      initialPeriod: "7d",
    })
  })
})
