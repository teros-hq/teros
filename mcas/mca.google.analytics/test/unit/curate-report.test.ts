/**
 * curateReport — flattens a raw GA4 `runReport` / `runRealtimeReport` /
 * `batchRunReports` response into the compact shape the renderer consumes:
 * dimension/metric values become plain string arrays, totals/min/max collapse
 * to metric-value arrays, and metadata is whitelisted to currency + timezone.
 *
 * The renderer renders exactly this shape, so the asserts pin the full payload:
 * value un-wrapping ({value:"US"} → "US"), the rowCount fallback, and the
 * metadata whitelist (extra GA4 fields must NOT leak through).
 */

import { describe, expect, it } from "bun:test"
import { curateReport } from "../../src/helpers"

describe("curateReport — full report", () => {
  const raw = {
    dimensionHeaders: [{ name: "country" }, { name: "deviceCategory" }],
    metricHeaders: [
      { name: "activeUsers", type: "TYPE_INTEGER" },
      { name: "sessions", type: "TYPE_INTEGER" },
    ],
    rows: [
      {
        dimensionValues: [{ value: "US" }, { value: "mobile" }],
        metricValues: [{ value: "1234" }, { value: "2000" }],
      },
      {
        dimensionValues: [{ value: "ES" }, { value: "desktop" }],
        metricValues: [{ value: "567" }, { value: "800" }],
      },
    ],
    rowCount: 2,
    totals: [
      {
        dimensionValues: [{ value: "RESERVED_TOTAL" }],
        metricValues: [{ value: "1801" }, { value: "2800" }],
      },
    ],
    minimums: [{ metricValues: [{ value: "567" }, { value: "800" }] }],
    maximums: [{ metricValues: [{ value: "1234" }, { value: "2000" }] }],
    metadata: {
      currencyCode: "USD",
      timeZone: "America/Los_Angeles",
      subjectToThresholding: true,
    },
    propertyQuota: { tokensPerDay: { consumed: 4, remaining: 996 } },
  }

  it("produces the exact curated payload", () => {
    expect(curateReport(raw)).toEqual({
      dimensionHeaders: [{ name: "country" }, { name: "deviceCategory" }],
      metricHeaders: [
        { name: "activeUsers", type: "TYPE_INTEGER" },
        { name: "sessions", type: "TYPE_INTEGER" },
      ],
      rows: [
        { dimensionValues: ["US", "mobile"], metricValues: ["1234", "2000"] },
        { dimensionValues: ["ES", "desktop"], metricValues: ["567", "800"] },
      ],
      rowCount: 2,
      // totals/min/max carry ONLY metric values (dimensionValues are dropped).
      totals: [["1801", "2800"]],
      minimums: [["567", "800"]],
      maximums: [["1234", "2000"]],
      // metadata is whitelisted — subjectToThresholding must NOT leak through.
      metadata: { currencyCode: "USD", timeZone: "America/Los_Angeles" },
      propertyQuota: { tokensPerDay: { consumed: 4, remaining: 996 } },
    })
  })
})

describe("curateReport — rowCount", () => {
  const oneRow = {
    rows: [{ dimensionValues: [{ value: "a" }], metricValues: [{ value: "1" }] }],
  }

  it("uses the upstream rowCount even when it exceeds the returned rows (paged result)", () => {
    expect(curateReport({ ...oneRow, rowCount: 5000 }).rowCount).toBe(5000)
  })

  it("falls back to rows.length when rowCount is absent", () => {
    expect(curateReport(oneRow).rowCount).toBe(1)
  })

  it("falls back to 0 for an empty response", () => {
    expect(curateReport({}).rowCount).toBe(0)
  })
})

describe("curateReport — boundaries", () => {
  it("returns empty arrays and undefined optionals for an empty response", () => {
    const out = curateReport({})
    expect(out.dimensionHeaders).toEqual([])
    expect(out.metricHeaders).toEqual([])
    expect(out.rows).toEqual([])
    expect(out.totals).toBeUndefined()
    expect(out.minimums).toBeUndefined()
    expect(out.maximums).toBeUndefined()
    expect(out.metadata).toBeUndefined()
    expect(out.propertyQuota).toBeUndefined()
  })

  it("defaults missing dimensionValues/metricValues on a row to empty arrays", () => {
    expect(curateReport({ rows: [{}] }).rows).toEqual([
      { dimensionValues: [], metricValues: [] },
    ])
  })

  it("keeps metadata.currencyCode and leaves timeZone undefined when partial", () => {
    const out = curateReport({ metadata: { currencyCode: "EUR" } })
    expect(out.metadata?.currencyCode).toBe("EUR")
    expect(out.metadata?.timeZone).toBeUndefined()
  })

  it("omits metadata entirely when absent (not an empty object)", () => {
    expect(curateReport({ rows: [] }).metadata).toBeUndefined()
  })
})
