/**
 * Pure parser / whitelist helpers for the GA4 MCA.
 *
 * These functions own the resource-name normalization contract (numeric id ↔
 * "properties/{id}" / "accounts/{id}") and the field-whitelist that keeps null
 * noise out of curated responses. They run on every tool call, so a silent
 * change of meaning here (e.g. a regex tweak, or `pick` switching to a truthy
 * check and dropping `0`/`""`/`false`) would corrupt every downstream renderer.
 * The asserts pin exact payloads so such mutations turn red.
 */

import { describe, expect, it } from "bun:test"
import {
  accountIdOf,
  parseAccountName,
  parsePropertyName,
  parseStreamId,
  pick,
  propertyIdOf,
} from "../../src/helpers"

describe("parsePropertyName", () => {
  it("wraps a bare numeric id", () => {
    expect(parsePropertyName("123456")).toBe("properties/123456")
  })

  it("passes through an already-qualified name (idempotent)", () => {
    expect(parsePropertyName("properties/123456")).toBe("properties/123456")
  })

  it("trims surrounding whitespace before wrapping", () => {
    expect(parsePropertyName("  789  ")).toBe("properties/789")
  })

  it("RE-VALIDATES the prefixed branch: a non-numeric tail is rejected (not passed through)", () => {
    // Hardened: "properties/abc" used to be returned verbatim and would 404
    // mid-call. It now fails fast at the boundary.
    expect(() => parsePropertyName("properties/abc")).toThrow(/INVALID_ARGUMENT/)
  })

  it("RE-VALIDATES the prefixed branch: a deeper resource path is rejected", () => {
    expect(() => parsePropertyName("properties/123/dataStreams/9")).toThrow(/numeric ID/)
  })

  it("coerces a numeric (non-string) input via String() before wrapping", () => {
    // The LLM can pass a JSON number; `String(input)` must run before `.trim()`.
    expect(parsePropertyName(123456 as unknown as string)).toBe("properties/123456")
  })

  it("rejects an empty string", () => {
    expect(() => parsePropertyName("")).toThrow(/propertyId must be a non-empty string/)
  })

  it("rejects a whitespace-only string", () => {
    expect(() => parsePropertyName("   ")).toThrow(/non-empty string/)
  })

  it("rejects a non-numeric unqualified id", () => {
    expect(() => parsePropertyName("abc")).toThrow(/must be a numeric ID/)
  })

  it("rejects a numeric id with trailing characters", () => {
    expect(() => parsePropertyName("123abc")).toThrow(/INVALID_ARGUMENT/)
  })

  it("rejects an accounts/-qualified name (wrong resource type)", () => {
    expect(() => parsePropertyName("accounts/123")).toThrow(/must be a numeric ID/)
  })
})

describe("parseAccountName", () => {
  it("wraps a bare numeric id", () => {
    expect(parseAccountName("789")).toBe("accounts/789")
  })

  it("passes through an already-qualified name (idempotent)", () => {
    expect(parseAccountName("accounts/789")).toBe("accounts/789")
  })

  it("trims surrounding whitespace before wrapping", () => {
    expect(parseAccountName("  42  ")).toBe("accounts/42")
  })

  it("RE-VALIDATES the prefixed branch: a non-numeric tail is rejected (not passed through)", () => {
    expect(() => parseAccountName("accounts/xyz")).toThrow(/INVALID_ARGUMENT/)
  })

  it("coerces a numeric (non-string) input via String() before wrapping", () => {
    expect(parseAccountName(42 as unknown as string)).toBe("accounts/42")
  })

  it("rejects an empty string", () => {
    expect(() => parseAccountName("")).toThrow(/accountId must be a non-empty string/)
  })

  it("rejects a properties/-qualified name (wrong resource type)", () => {
    expect(() => parseAccountName("properties/789")).toThrow(/must be a numeric ID/)
  })
})

describe("parseStreamId", () => {
  it("returns a bare numeric id unchanged", () => {
    expect(parseStreamId("987654")).toBe("987654")
  })

  it("trims surrounding whitespace", () => {
    expect(parseStreamId("  321  ")).toBe("321")
  })

  it("coerces a numeric (non-string) input via String()", () => {
    expect(parseStreamId(321 as unknown as string)).toBe("321")
  })

  it("rejects a non-numeric id", () => {
    expect(() => parseStreamId("abc")).toThrow(/streamId must be a numeric ID/)
  })

  it("rejects an empty string", () => {
    expect(() => parseStreamId("")).toThrow(/INVALID_ARGUMENT/)
  })

  it("rejects a full resource path (only the bare id is accepted)", () => {
    expect(() => parseStreamId("properties/1/dataStreams/2")).toThrow(/INVALID_ARGUMENT/)
  })
})

describe("propertyIdOf", () => {
  it("strips the properties/ prefix to the bare id", () => {
    expect(propertyIdOf("properties/123456")).toBe("123456")
  })

  it("returns undefined for null", () => {
    expect(propertyIdOf(null)).toBeUndefined()
  })

  it("returns undefined for undefined", () => {
    expect(propertyIdOf(undefined)).toBeUndefined()
  })

  it("returns undefined for empty string (falsy)", () => {
    expect(propertyIdOf("")).toBeUndefined()
  })

  it("returns the input unchanged when it is already a bare id", () => {
    expect(propertyIdOf("123456")).toBe("123456")
  })

  it("returns the input unchanged when the prefix has a non-numeric tail", () => {
    expect(propertyIdOf("properties/abc")).toBe("properties/abc")
  })

  it("does not partial-match a deeper resource path", () => {
    expect(propertyIdOf("properties/123/dataStreams/9")).toBe(
      "properties/123/dataStreams/9",
    )
  })
})

describe("accountIdOf", () => {
  it("strips the accounts/ prefix to the bare id", () => {
    expect(accountIdOf("accounts/789")).toBe("789")
  })

  it("returns undefined for null", () => {
    expect(accountIdOf(null)).toBeUndefined()
  })

  it("returns undefined for undefined", () => {
    expect(accountIdOf(undefined)).toBeUndefined()
  })

  it("returns undefined for empty string (falsy)", () => {
    expect(accountIdOf("")).toBeUndefined()
  })

  it("returns the input unchanged when it is already a bare id", () => {
    expect(accountIdOf("789")).toBe("789")
  })

  it("returns the input unchanged when the prefix has a non-numeric tail", () => {
    expect(accountIdOf("accounts/xyz")).toBe("accounts/xyz")
  })
})

describe("pick", () => {
  // pick's return type optimistically claims all K keys are present, but at
  // runtime it omits null/undefined ones — so subset assertions are cast to a
  // loose record type. The runtime deep-equality is unaffected.
  const picked = (v: unknown) => v as Record<string, unknown> | undefined

  it("keeps only the declared keys and drops everything else", () => {
    expect(picked(pick({ a: 1, b: 2, c: 3, secret: "shhh" }, ["a", "c"]))).toEqual({
      a: 1,
      c: 3,
    })
  })

  it("keeps falsy-but-defined values (0, '', false) — only null/undefined are dropped", () => {
    const obj = { a: 0, b: "", c: false, d: null, e: undefined }
    expect(picked(pick(obj, ["a", "b", "c", "d", "e"]))).toEqual({ a: 0, b: "", c: false })
  })

  it("drops keys whose value is null or undefined", () => {
    const obj: Record<string, unknown> = { keep: "yes", gone: null, missing: undefined }
    expect(picked(pick(obj, ["keep", "gone", "missing"]))).toEqual({ keep: "yes" })
  })

  it("returns an empty object when none of the keys are present with values", () => {
    const obj: Record<string, unknown> = { a: undefined }
    expect(picked(pick(obj, ["a"]))).toEqual({})
  })

  it("returns undefined for a null source object", () => {
    expect(pick<{ a: number }, "a">(null, ["a"])).toBeUndefined()
  })

  it("returns undefined for an undefined source object", () => {
    expect(pick<{ a: number }, "a">(undefined, ["a"])).toBeUndefined()
  })
})
