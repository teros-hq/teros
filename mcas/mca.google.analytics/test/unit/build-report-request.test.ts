/**
 * buildReportRequest — the single normalization point shared by run-report,
 * run-realtime-report, and EVERY sub-request of batch-run-reports.
 *
 * Two contracts are pinned here because the GA4 Data API enforces them and a
 * silent regression resurfaces production bugs:
 *
 *  1. `dimensions`/`metrics` MUST be `[{ name }]`, never bare strings — GA4
 *     answers a raw-string body with `400 INVALID_ARGUMENT`. This was the
 *     batch-run-reports bug (#1): it forwarded `requests` un-normalized.
 *  2. `limit`/`offset` MUST be int64-as-STRING and survive the value `0`/`100`
 *     — guarded with `!= null`, so a truthiness mutation (`args.offset ? …`)
 *     dropping `offset:"0"` turns these red (#2).
 *
 * Realtime mode shares the dims/metrics contract but must NOT emit the
 * date-bound fields (`dateRanges`/`offset`/`currencyCode`/`metricAggregations`).
 */

import { describe, expect, it } from "bun:test"
import { buildReportRequest } from "../../src/helpers"

const DR = { startDate: "7daysAgo", endDate: "yesterday" }

describe("buildReportRequest — normalization (run-report shape)", () => {
  it("maps dimensions and metrics from string[] to [{ name }]", () => {
    const body = buildReportRequest({
      dimensions: ["country", "deviceCategory"],
      metrics: ["activeUsers", "sessions"],
      dateRanges: [DR],
    })
    expect(body.dimensions).toEqual([{ name: "country" }, { name: "deviceCategory" }])
    expect(body.metrics).toEqual([{ name: "activeUsers" }, { name: "sessions" }])
  })

  it("defaults dimensions to [] when omitted (metrics still required)", () => {
    const body = buildReportRequest({ metrics: ["activeUsers"], dateRanges: [DR] })
    expect(body.dimensions).toEqual([])
  })

  it("coerces limit to a STRING (100 → \"100\")", () => {
    expect(buildReportRequest({ metrics: ["x"], dateRanges: [DR], limit: 100 }).limit).toBe("100")
  })

  it("coerces offset to a STRING and KEEPS the boundary value 0 (\"0\", not dropped)", () => {
    // `args.offset != null` — a truthiness check would drop 0 here.
    expect(buildReportRequest({ metrics: ["x"], dateRanges: [DR], offset: 0 }).offset).toBe("0")
  })

  it("coerces the boundary value limit:0 to \"0\"", () => {
    expect(buildReportRequest({ metrics: ["x"], dateRanges: [DR], limit: 0 }).limit).toBe("0")
  })

  it("leaves limit/offset undefined when not provided", () => {
    const body = buildReportRequest({ metrics: ["x"], dateRanges: [DR] })
    expect(body.limit).toBeUndefined()
    expect(body.offset).toBeUndefined()
  })

  it("produces the exact full request body, passing filters/orderBys through verbatim", () => {
    const body = buildReportRequest({
      dimensions: ["country"],
      metrics: ["activeUsers", "sessions"],
      dateRanges: [DR],
      dimensionFilter: { filter: { fieldName: "country" } },
      metricFilter: { filter: { fieldName: "sessions" } },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 100,
      offset: 20,
      keepEmptyRows: true,
      returnPropertyQuota: true,
      currencyCode: "USD",
      metricAggregations: ["TOTAL"],
    })
    expect(body).toEqual({
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      dimensionFilter: { filter: { fieldName: "country" } },
      metricFilter: { filter: { fieldName: "sessions" } },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "100",
      offset: "20",
      keepEmptyRows: true,
      returnPropertyQuota: true,
      currencyCode: "USD",
      metricAggregations: ["TOTAL"],
      dateRanges: [DR],
    })
  })
})

describe("buildReportRequest — required-field validation", () => {
  it("throws INVALID_ARGUMENT when metrics is empty", () => {
    expect(() => buildReportRequest({ metrics: [], dateRanges: [DR] })).toThrow(
      /metrics must contain at least one entry/,
    )
  })

  it("throws INVALID_ARGUMENT when metrics is missing", () => {
    expect(() => buildReportRequest({ dateRanges: [DR] })).toThrow(/metrics must contain/)
  })

  it("checks metrics BEFORE dateRanges (metrics error wins when both are absent)", () => {
    expect(() => buildReportRequest({})).toThrow(/metrics must contain/)
  })

  it("throws INVALID_ARGUMENT when dateRanges is missing (non-realtime)", () => {
    expect(() => buildReportRequest({ metrics: ["activeUsers"] })).toThrow(
      /dateRanges must contain at least one entry/,
    )
  })

  it("throws INVALID_ARGUMENT when dateRanges is an empty array (non-realtime)", () => {
    expect(() => buildReportRequest({ metrics: ["activeUsers"], dateRanges: [] })).toThrow(
      /dateRanges must contain/,
    )
  })
})

describe("buildReportRequest — realtime mode", () => {
  it("does NOT require dateRanges", () => {
    expect(() => buildReportRequest({ metrics: ["activeUsers"] }, { realtime: true })).not.toThrow()
  })

  it("still requires metrics", () => {
    expect(() => buildReportRequest({ metrics: [] }, { realtime: true })).toThrow(
      /metrics must contain/,
    )
  })

  it("normalizes dims/metrics and coerces limit, but DROPS the date-bound fields", () => {
    // Even though the caller passes them, realtime must not forward
    // dateRanges/offset/currencyCode/metricAggregations/keepEmptyRows.
    const body = buildReportRequest(
      {
        dimensions: ["country"],
        metrics: ["activeUsers"],
        limit: 50,
        returnPropertyQuota: true,
        // these must be stripped in realtime mode:
        dateRanges: [DR],
        offset: 99,
        currencyCode: "EUR",
        metricAggregations: ["TOTAL"],
        keepEmptyRows: true,
      },
      { realtime: true },
    )
    expect(body.dimensions).toEqual([{ name: "country" }])
    expect(body.metrics).toEqual([{ name: "activeUsers" }])
    expect(body.limit).toBe("50")
    expect("dateRanges" in body).toBe(false)
    expect("offset" in body).toBe(false)
    expect("currencyCode" in body).toBe(false)
    expect("metricAggregations" in body).toBe(false)
    expect("keepEmptyRows" in body).toBe(false)
  })
})
