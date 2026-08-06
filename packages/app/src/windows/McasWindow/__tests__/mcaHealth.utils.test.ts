/**
 * Unit coverage for the MCA-health error-extraction path (PR #346 MAJOR-2). `extractErrorMessage`
 * mirrors the backend `success`/`error` wire shape and has 3-4 distinct branches that were only
 * exercised on one path before; each is pinned here. `resultToRow` + `shortenError` round out the
 * fail-row mapping the dashboard renders and persists. Pure functions, so no React harness needed.
 */
import { describe, expect, it } from "bun:test"
import type {
  McaData,
  McaHealthRecord,
  McaTestResult,
  McaToolSchema,
} from "../../../services/AppApi"
import {
  ALL_VISIBLE,
  buildFormInput,
  buildRows,
  classifyAvailabilityTier,
  classifyTools,
  computeHealth,
  deriveOverall,
  extractErrorMessage,
  filterRows,
  isFlatSchema,
  isReadOnlyTool,
  rawJsonRequiredFilled,
  resultToRow,
  shortenError,
  toolKey,
  toolNeedsInput,
} from "../mcaHealth.utils"
import type { McaRowData, McaToolResult } from "../mcaStatus.types"

/** Build an inputSchema literal for the input-gate helpers. */
const inputSchema = (
  over: Partial<McaToolSchema["inputSchema"]> = {},
): McaToolSchema["inputSchema"] => ({ type: "object", properties: {}, ...over })

/** Build a full tool schema (annotations optional) for classify/needs-input helpers. */
const toolSchema = (over: Partial<McaToolSchema> = {}): McaToolSchema => ({
  tool: "t",
  requiresInput: false,
  inputSchema: inputSchema(),
  ...over,
})

const baseResult = (over: Partial<McaTestResult>): McaTestResult => ({
  mcaId: "m1",
  tool: "t1",
  appId: "a1",
  success: false,
  result: undefined,
  ...over,
})

describe("extractErrorMessage — every branch", () => {
  it("prefers the explicit `error` wire field", () => {
    expect(extractErrorMessage(baseResult({ error: "boom", result: "ignored" }))).toBe("boom")
  })

  it("falls back to `result` when it is a non-empty string", () => {
    expect(extractErrorMessage(baseResult({ result: "raw failure" }))).toBe("raw failure")
  })

  it("reads message/error/text from an object `result` (in that precedence)", () => {
    expect(extractErrorMessage(baseResult({ result: { message: "m" } }))).toBe("m")
    expect(extractErrorMessage(baseResult({ result: { error: "e" } }))).toBe("e")
    expect(extractErrorMessage(baseResult({ result: { text: "x" } }))).toBe("x")
    // message wins over error/text.
    expect(extractErrorMessage(baseResult({ result: { message: "m", error: "e" } }))).toBe("m")
  })

  it("returns undefined when nothing carries text", () => {
    expect(extractErrorMessage(baseResult({ result: undefined }))).toBeUndefined()
    expect(extractErrorMessage(baseResult({ error: "   ", result: "" }))).toBeUndefined()
    expect(extractErrorMessage(baseResult({ result: { code: 500 } }))).toBeUndefined()
    expect(extractErrorMessage(baseResult({ result: 42 }))).toBeUndefined()
  })
})

describe("shortenError", () => {
  it("passes short messages through and truncates at 300 chars", () => {
    expect(shortenError(undefined)).toBeUndefined()
    expect(shortenError("short")).toBe("short")
    const long = "x".repeat(500)
    expect(shortenError(long)?.length).toBe(300)
  })
})

describe("resultToRow", () => {
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts ? `${key}:${JSON.stringify(opts)}` : key

  it("maps success to a plain ok row with no note, stamped with a fresh testedAt", () => {
    const { row, shortError } = resultToRow(baseResult({ success: true }), "t1", t)
    expect(row.tool).toBe("t1")
    expect(row.status).toBe("ok")
    expect(row.notes).toBeUndefined()
    // Stamped now so the "last tested" line updates immediately (no reload) — value is a valid ISO.
    expect(typeof row.testedAt).toBe("string")
    expect(Number.isNaN(Date.parse(row.testedAt as string))).toBe(false)
    expect(shortError).toBeUndefined()
  })

  it("maps a failure with text to a fail row carrying the extracted+truncated message", () => {
    const { row, shortError } = resultToRow(baseResult({ error: "nope" }), "t1", t)
    expect(row.status).toBe("fail")
    expect(shortError).toBe("nope")
    expect(row.notes).toBe('mca.status.run.error:{"message":"nope"}')
  })

  it("maps a textless failure to the generic Failed label with no persisted error", () => {
    const { row, shortError } = resultToRow(baseResult({ result: {} }), "t1", t)
    expect(row.status).toBe("fail")
    expect(shortError).toBeUndefined()
    expect(row.notes).toBe("mca.status.run.failed")
  })
})

describe("deriveOverall — definitive-only denominator", () => {
  it("is pending when nothing is definitive", () => {
    expect(deriveOverall([{ status: "pending" }, { status: "skip" }])).toBe("pending")
  })

  it("ignores pending/skip so an all-passing partial run stays operational", () => {
    expect(deriveOverall([{ status: "ok" }, { status: "pending" }])).toBe("operational")
  })

  it("is failed only when every definitive result failed, else partial", () => {
    expect(deriveOverall([{ status: "fail" }, { status: "skip" }])).toBe("failed")
    expect(deriveOverall([{ status: "ok" }, { status: "fail" }])).toBe("partial")
    expect(deriveOverall([{ status: "ok" }, { status: "confirm" }])).toBe("partial")
  })
})

describe("classifyAvailabilityTier — badge/chip agree (precedence fix)", () => {
  const mca = (availability: Partial<McaData["availability"]>): McaData => ({
    mcaId: "m1",
    name: "M1",
    description: "",
    category: "utility",
    tools: [],
    availability: {
      enabled: true,
      multi: false,
      system: false,
      hidden: false,
      role: "user",
      ...availability,
    },
  })
  const row = (m: McaData): McaRowData => ({
    mca: m,
    overall: "pending",
    toolRows: [],
    testedAt: undefined,
  })

  it("classifies hidden BEFORE disabled (a hidden+disabled MCA is 'hidden')", () => {
    // Regression: filterRows once ordered disabled-before-hidden while the badge ordered
    // hidden-before-disabled, so the 'Hidden' badge was gated by the 'Disabled' chip.
    expect(classifyAvailabilityTier(mca({ enabled: false, hidden: true }))).toBe("hidden")
  })

  it("follows system → hidden → disabled → role precedence", () => {
    expect(classifyAvailabilityTier(mca({ system: true, hidden: true, enabled: false }))).toBe(
      "system",
    )
    expect(classifyAvailabilityTier(mca({ enabled: false }))).toBe("disabled")
    expect(classifyAvailabilityTier(mca({ role: "admin" }))).toBe("adminOnly")
    expect(classifyAvailabilityTier(mca({}))).toBe("user")
  })

  it("filterRows gates a hidden+disabled MCA by the Hidden chip, not the Disabled chip", () => {
    const rows = [row(mca({ enabled: false, hidden: true }))]
    // Turning OFF 'Hidden' removes it (matches its badge); turning OFF 'Disabled' keeps it.
    expect(filterRows(rows, { ...ALL_VISIBLE, showHidden: false }, "")).toHaveLength(0)
    expect(filterRows(rows, { ...ALL_VISIBLE, showDisabled: false }, "")).toHaveLength(1)
  })
})

describe("buildRows — persisted-tool join + orphan preservation", () => {
  const mca = (mcaId: string, tools: string[]): McaData => ({
    mcaId,
    name: mcaId.toUpperCase(),
    description: "",
    category: "utility",
    tools,
    availability: { enabled: true, multi: false, system: false, hidden: false, role: "user" },
  })
  const record = (
    over: Partial<McaHealthRecord> & Pick<McaHealthRecord, "mcaId" | "tool" | "status">,
  ): McaHealthRecord => over
  const health = (records: McaHealthRecord[]): Map<string, McaHealthRecord> =>
    new Map(records.map((r) => [toolKey(r.mcaId, r.tool), r]))

  it("resolves a catalog tool with no persisted record to pending", () => {
    const [rowData] = buildRows([mca("m1", ["a", "b"])], health([]))
    expect(rowData.toolRows).toEqual([
      { tool: "a", status: "pending" },
      { tool: "b", status: "pending" },
    ])
    expect(rowData.overall).toBe("pending")
  })

  it("surfaces a persisted tool no longer in the catalog instead of dropping it (spec 277-281)", () => {
    const rows = buildRows(
      [mca("m1", ["a"])],
      health([
        record({ mcaId: "m1", tool: "a", status: "ok", testedAt: "2026-07-01T00:00:00.000Z" }),
        // "gone" was tested but has since dropped out of the catalog.
        record({
          mcaId: "m1",
          tool: "gone",
          status: "fail",
          error: "boom",
          testedAt: "2026-07-02T00:00:00.000Z",
        }),
      ]),
    )
    const tools = rows[0].toolRows.map((r) => r.tool)
    expect(tools).toContain("gone")
    const orphan = rows[0].toolRows.find((r) => r.tool === "gone")
    expect(orphan).toMatchObject({ status: "fail", notes: "boom" })
    // orphan counts toward overall (one ok + one fail → partial) and last-tested reflects it.
    expect(rows[0].overall).toBe("partial")
    expect(rows[0].testedAt).toBe("2026-07-02T00:00:00.000Z")
  })
})

describe("computeHealth — definitive denominator (D-05)", () => {
  const rows = (statuses: McaToolResult["status"][]): McaToolResult[] =>
    statuses.map((status, i) => ({ tool: `t${i}`, status }))

  it("counts ok/confirm/fail and excludes pending/skip from the denominator", () => {
    expect(computeHealth(rows(["ok", "ok", "confirm", "fail", "pending", "skip"]))).toEqual({
      counted: 4,
      passing: 2,
      confirm: 1,
      fail: 1,
    })
  })

  it("is all-zero for a never-tested set (counted === 0 boundary)", () => {
    expect(computeHealth(rows(["pending", "skip"]))).toEqual({
      counted: 0,
      passing: 0,
      confirm: 0,
      fail: 0,
    })
    expect(computeHealth([])).toEqual({ counted: 0, passing: 0, confirm: 0, fail: 0 })
  })
})

describe("classifyTools / isReadOnlyTool — fail-safe destructive default (D-09)", () => {
  it("only readOnlyHint:true is read-only; everything else (incl. unannotated) is destructive", () => {
    expect(isReadOnlyTool("x", { readOnlyHint: true })).toBe(true)
    expect(isReadOnlyTool("x", { readOnlyHint: false })).toBe(false)
    expect(isReadOnlyTool("x", { destructiveHint: true })).toBe(false)
    expect(isReadOnlyTool("x", undefined)).toBe(false)
  })

  it("splits by annotation, sending unannotated/unmatched tools to destructive", () => {
    const { readOnly, destructive } = classifyTools(
      ["ro", "rw", "unknown"],
      [
        toolSchema({ tool: "ro", annotations: { readOnlyHint: true } }),
        toolSchema({ tool: "rw", annotations: { readOnlyHint: false } }),
      ],
    )
    expect(readOnly).toEqual(["ro"])
    expect(destructive).toEqual(["rw", "unknown"])
  })

  it("classifies EVERY tool destructive when schemas are empty (fetch failed → nothing runs unconfirmed)", () => {
    expect(classifyTools(["a", "b"], [])).toEqual({ readOnly: [], destructive: ["a", "b"] })
  })
})

describe("input-gate helpers — never fire a tool with missing/partial input (D-01/D-02)", () => {
  it("toolNeedsInput gates on required.length, not the properties count", () => {
    expect(toolNeedsInput(undefined)).toBe(false)
    expect(toolNeedsInput(toolSchema({ inputSchema: inputSchema({ required: [] }) }))).toBe(false)
    // Malformed schema: a required key with empty properties still needs input — otherwise the tool
    // would run with {} despite declaring the field required.
    expect(toolNeedsInput(toolSchema({ inputSchema: inputSchema({ required: ["q"] }) }))).toBe(true)
  })

  it("isFlatSchema: all-primitive → flat; nested/array or missing-required-prop → not flat; empty → flat", () => {
    expect(isFlatSchema(inputSchema())).toBe(true)
    expect(
      isFlatSchema(
        inputSchema({
          properties: { a: { type: "string" }, n: { type: "number" }, b: { type: "boolean" } },
        }),
      ),
    ).toBe(true)
    expect(
      isFlatSchema(inputSchema({ properties: { a: { type: "array", items: { type: "string" } } } })),
    ).toBe(false)
    expect(isFlatSchema(inputSchema({ properties: { a: { type: "object" } } }))).toBe(false)
    // A required key with no matching property definition can't be a generated field → not flat.
    expect(
      isFlatSchema(inputSchema({ properties: { a: { type: "string" } }, required: ["a", "missing"] })),
    ).toBe(false)
  })

  it("rawJsonRequiredFilled: parse error / non-object / blank-required → false; all required set → true", () => {
    const s = inputSchema({ properties: { q: { type: "string" } }, required: ["q"] })
    expect(rawJsonRequiredFilled("{ not json", s)).toBe(false)
    expect(rawJsonRequiredFilled("[]", s)).toBe(false)
    expect(rawJsonRequiredFilled('{"q":"   "}', s)).toBe(false)
    expect(rawJsonRequiredFilled('{"q":"hi"}', s)).toBe(true)
  })

  it("buildFormInput: flat → formValues verbatim; non-flat parse error / missing required → null", () => {
    const flat = inputSchema({ properties: { a: { type: "string" } } })
    expect(buildFormInput(flat, { a: "v" }, "")).toEqual({ a: "v" })

    const nonFlat = inputSchema({
      properties: { a: { type: "array", items: { type: "string" } }, q: { type: "string" } },
      required: ["q"],
    })
    expect(buildFormInput(nonFlat, {}, "{ broken")).toBeNull()
    expect(buildFormInput(nonFlat, {}, '{"a":[]}')).toBeNull() // required `q` missing
    expect(buildFormInput(nonFlat, {}, '{"a":[],"q":"x"}')).toEqual({ a: [], q: "x" })
  })
})
