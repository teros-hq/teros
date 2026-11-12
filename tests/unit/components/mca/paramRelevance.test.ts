/**
 * Unit tests — param relevance ranking and value bounding.
 *
 * Maps to engineering principle 4 (strict interfaces) and to the spec's
 * requirement that no parameter value is hidden behind an unexpandable
 * placeholder. The old ParamsTable collapsed every object to "{...}"; these
 * rules are what replace that.
 */

import { describe, expect, it } from "bun:test"
import {
  boundValue,
  PARAM_CAPS,
  rankParams,
} from "../../../../packages/app/src/components/mca/primitives/param-relevance"

const SCHEMA = {
  type: "object" as const,
  properties: {
    fileId: { type: "string", description: "Target file." },
    role: { type: "string", enum: ["reader", "writer"], description: "Access level." },
    sendEmail: { type: "boolean", description: "Notify the recipient." },
    permissions: { type: "object", description: "Extra permission flags." },
  },
  required: ["fileId", "role"],
}

describe("rankParams", () => {
  it("(1) puts schema-required params first", () => {
    const ranked = rankParams({ sendEmail: true, role: "writer", fileId: "f1" }, SCHEMA)
    expect(ranked.map((p) => p.key)).toEqual(["fileId", "role", "sendEmail"])
  })

  it("(2) orders declared-optional above undeclared", () => {
    const ranked = rankParams({ mystery: 1, sendEmail: true }, SCHEMA)
    expect(ranked.map((p) => p.key)).toEqual(["sendEmail", "mystery"])
  })

  it("(3) flags undeclared params so the UI can surface them", () => {
    const ranked = rankParams({ mystery: 1 }, SCHEMA)
    expect(ranked[0]).toMatchObject({ key: "mystery", undeclared: true, required: false })
  })

  it("(4) carries the schema description and enum onto the row", () => {
    const ranked = rankParams({ role: "writer" }, SCHEMA)
    expect(ranked[0].description).toBe("Access level.")
    expect(ranked[0].enumValues).toEqual(["reader", "writer"])
  })

  it("(5) sorts non-containers before containers within the same tier", () => {
    const ranked = rankParams({ permissions: { a: 1 }, sendEmail: true }, SCHEMA)
    expect(ranked.map((p) => p.key)).toEqual(["sendEmail", "permissions"])
  })

  it("(6) marks containers", () => {
    const ranked = rankParams({ permissions: { a: 1 }, sendEmail: true }, SCHEMA)
    expect(ranked.find((p) => p.key === "permissions")?.container).toBe(true)
    expect(ranked.find((p) => p.key === "sendEmail")?.container).toBe(false)
  })

  it("(7) returns only keys present in input, never schema-only keys", () => {
    const ranked = rankParams({ fileId: "f1" }, SCHEMA)
    expect(ranked.map((p) => p.key)).toEqual(["fileId"])
  })

  // `undeclared` means "the schema was consulted and this key was not in
  // it" — never "we had no schema to consult". With no schema at all
  // (fetch in flight, failed fetch, no appId, …) nothing was consulted, so
  // no param may be flagged "not in schema": that would be evidence of
  // absence rendered as evidence of presence in a security-approval UI.
  it("(8) works with no schema at all — input order kept, nothing flagged undeclared", () => {
    const ranked = rankParams({ b: 1, a: 2 }, undefined)
    expect(ranked.map((p) => p.key)).toEqual(["b", "a"])
    expect(ranked.every((p) => p.undeclared)).toBe(false)
  })

  it("(9) returns an empty array for absent input", () => {
    expect(rankParams(undefined, SCHEMA)).toEqual([])
  })

  it("(18) de-duplicates a repeated key in schema.required into a single row", () => {
    const schema = { ...SCHEMA, required: ["fileId", "fileId"] }
    const ranked = rankParams({ fileId: "f1" }, schema)
    expect(ranked.map((p) => p.key)).toEqual(["fileId"])
  })

  it("(19) flags undeclared when a required key is absent from properties", () => {
    const schema = {
      type: "object" as const,
      properties: {},
      required: ["ghost"],
    }
    const ranked = rankParams({ ghost: 1 }, schema)
    expect(ranked[0]).toMatchObject({ key: "ghost", required: true, undeclared: true })
  })
})

describe("boundValue", () => {
  it("(10) renders a primitive as its string form with no children", () => {
    expect(boundValue("writer")).toEqual({
      text: "writer",
      truncated: false,
      children: [],
      hiddenCount: 0,
      atDepthLimit: false,
    })
  })

  it("(11) summarises an object by field count and exposes expandable children", () => {
    const result = boundValue({ a: 1, b: 2, c: 3 })
    expect(result.text).toBe("{3 fields}")
    expect(result.children.map((c) => c.key)).toEqual(["a", "b", "c"])
  })

  it("(12) summarises an array by item count", () => {
    const result = boundValue([10, 20])
    expect(result.text).toBe("[2 items]")
    expect(result.children.map((c) => c.key)).toEqual(["0", "1"])
  })

  it("(13) truncates a long string at maxChars and flags it", () => {
    const long = "x".repeat(PARAM_CAPS.maxChars + 50)
    const result = boundValue(long)
    expect(result.text.length).toBe(PARAM_CAPS.maxChars)
    expect(result.truncated).toBe(true)
  })

  it("(14) caps children at maxItems and flags truncation", () => {
    const big = Array.from({ length: PARAM_CAPS.maxItems + 5 }, (_, i) => i)
    const result = boundValue(big)
    expect(result.children.length).toBe(PARAM_CAPS.maxItems)
    expect(result.truncated).toBe(true)
  })

  it("(15) stops expanding at maxDepth — deep containers expose no children", () => {
    const result = boundValue({ a: 1 }, PARAM_CAPS.maxDepth)
    expect(result.children).toEqual([])
    expect(result.text).toBe("{1 fields}")
  })

  it("(16) renders null and undefined without throwing", () => {
    expect(boundValue(null).text).toBe("null")
    expect(boundValue(undefined).text).toBe("undefined")
  })

  it("(17) survives a circular reference expanded one extra level in", () => {
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const result = boundValue(circular)
    expect(result.text).toBe("{2 fields}")
    expect(result.children.map((c) => c.key)).toEqual(["a", "self"])

    // Walk one level into the cycle — this is what would spin forever (or
    // blow the stack) if depth weren't threaded through recursive calls.
    const selfChild = result.children.find((c) => c.key === "self")
    const nested = boundValue(selfChild?.value, 1)
    expect(nested.text).toBe("{2 fields}")
    expect(nested.children.map((c) => c.key)).toEqual(["a", "self"])
  })
})

// ─── regression coverage added in review (bugs 8, 9, 11, and the depth-cap
// affordance). Each of these was a named gap: a malformed schema falsely
// flagging every param, truncation splitting a surrogate pair, an undocumented
// ordering rule, and a depth-capped container reporting nothing the UI could
// use to tell the reviewer that content was withheld.

describe("rankParams — schema shape edge cases", () => {
  it("(20) a schema with no `properties` key does not flag every param undeclared", () => {
    // A real MCP server may emit a bare {"type":"object"}. `properties` was never
    // consulted, so nothing can be said to be absent from it — same reasoning as
    // the absent-schema case, for the malformed sibling.
    const ranked = rankParams({ a: 1 }, { type: "object" } as never)

    expect(ranked.map((p) => p.key)).toEqual(["a"])
    expect(ranked[0]?.undeclared).toBe(false)
  })

  it("(21) a present-but-empty properties:{} still flags params undeclared", () => {
    // The schema WAS consulted and the key genuinely is not in it.
    const ranked = rankParams({ a: 1 }, { type: "object", properties: {} })

    expect(ranked[0]?.undeclared).toBe(true)
  })

  it("(22) Object.prototype keys in input do not inherit prototype members as schema data", () => {
    const ranked = rankParams(
      { __proto__: "x", constructor: "y", toString: "z" },
      { type: "object", properties: {}, required: ["hasOwnProperty"] },
    )

    for (const row of ranked) {
      expect(row.description).toBeUndefined()
      expect(row.enumValues).toBeUndefined()
    }
    expect(ranked.some((p) => p.key === "hasOwnProperty")).toBe(false)
  })

  it("(23) within the required tier, containers sort after scalars", () => {
    // Pins the documented ordering: container-first sort overrides schema order
    // INSIDE a tier. The comment above collectRequiredRows must say so.
    const ranked = rankParams(
      { obj: { a: 1 }, str: "s" },
      { type: "object", properties: { obj: {}, str: {} }, required: ["obj", "str"] },
    )

    expect(ranked.map((p) => p.key)).toEqual(["str", "obj"])
  })
})

describe("boundValue — truncation and depth-cap reporting", () => {
  it("(24) truncation never splits a surrogate pair", () => {
    const value = `${"a".repeat(PARAM_CAPS.maxChars - 1)}😀tail`
    const bounded = boundValue(value)

    expect(bounded.truncated).toBe(true)
    // A lone high surrogate would render as U+FFFD. Backing off one unit is correct.
    expect(/[\uD800-\uDBFF]$/.test(bounded.text)).toBe(false)
    expect(bounded.text).toBe("a".repeat(PARAM_CAPS.maxChars - 1))
  })

  it("(25) a string of exactly maxChars is kept whole", () => {
    const value = "a".repeat(PARAM_CAPS.maxChars)
    const bounded = boundValue(value)

    expect(bounded.truncated).toBe(false)
    expect(bounded.text).toBe(value)
    expect(bounded.fullText).toBeUndefined()
  })

  it("(25b) a clipped scalar keeps the whole string so 'show more' can show it", () => {
    // The tail used to be discarded here, which made the row's "show more" hint
    // inert: a reviewer approving a large `content` param saw 240 characters and
    // an invitation that led nowhere.
    const value = "b".repeat(PARAM_CAPS.maxChars + 50)
    const bounded = boundValue(value)

    expect(bounded.truncated).toBe(true)
    expect(bounded.text.length).toBe(PARAM_CAPS.maxChars)
    expect(bounded.fullText).toBe(value)
  })

  it("(25c) a depth-capped container carries no fullText — it has no scalar tail", () => {
    // `truncated` is true for both a clipped scalar and a depth-capped container.
    // Only the first has a rest to reveal; the second must keep getting the
    // nesting-limit statement instead of a toggle.
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    const bounded = boundValue(deep)

    expect(bounded.fullText).toBeUndefined()
  })

  it("(26) a container at the depth cap reports how much it withheld", () => {
    // Without a count the UI cannot distinguish "empty" from "hidden by the cap",
    // and the reviewer gets no signal that a value exists at all.
    const bounded = boundValue({ token: "sk-live-abc", scope: "admin" }, PARAM_CAPS.maxDepth)

    expect(bounded.children).toEqual([])
    expect(bounded.atDepthLimit).toBe(true)
    expect(bounded.hiddenCount).toBe(2)
  })

  it("(27) an item-capped container reports the remainder, not the depth limit", () => {
    const many = Object.fromEntries(
      Array.from({ length: PARAM_CAPS.maxItems + 3 }, (_, i) => [`k${i}`, i]),
    )
    const bounded = boundValue(many, 0)

    expect(bounded.children).toHaveLength(PARAM_CAPS.maxItems)
    expect(bounded.atDepthLimit).toBe(false)
    expect(bounded.hiddenCount).toBe(3)
  })

  it("(28) boundValue does not mutate the value it was given", () => {
    const input = { a: { b: 1 }, list: [1, 2] }
    const snapshot = JSON.stringify(input)

    boundValue(input, 0)

    expect(JSON.stringify(input)).toBe(snapshot)
  })
})
