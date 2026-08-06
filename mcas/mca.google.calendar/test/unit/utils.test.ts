import { describe, expect, it } from "bun:test"
import {
  pickFields,
  resolveFields,
  resolveFieldsList,
  sanitizeLimit,
  validateAttachment,
} from "../../src/tools/utils"

describe("pickFields", () => {
  it("keeps only declared fields", () => {
    const obj = { id: "1", summary: "foo", secret: "shhh" }
    expect(pickFields(obj, ["id", "summary"])).toEqual({ id: "1", summary: "foo" })
  })

  it("skips missing fields silently", () => {
    expect(pickFields({ id: "1" }, ["id", "missing"])).toEqual({ id: "1" })
  })
})

describe("sanitizeLimit", () => {
  it("returns default for non-numbers", () => {
    expect(sanitizeLimit(undefined, { max: 100, default: 25 })).toBe(25)
    expect(sanitizeLimit("foo", { max: 100, default: 25 })).toBe(25)
    expect(sanitizeLimit(NaN, { max: 100, default: 25 })).toBe(25)
  })

  it("clamps to min/max", () => {
    expect(sanitizeLimit(0, { max: 100, default: 25 })).toBe(1) // default min=1
    expect(sanitizeLimit(0, { min: 5, max: 100, default: 25 })).toBe(5)
    expect(sanitizeLimit(9999, { max: 100, default: 25 })).toBe(100)
  })

  it("floors fractional", () => {
    expect(sanitizeLimit(50.7, { max: 100, default: 25 })).toBe(50)
  })
})

describe("resolveFields", () => {
  const curated = { id: "1", name: "foo", extra: "bar" }
  const raw = { id: "1", name: "foo", extra: "bar", noisy: "noise" }

  it("returns raw when includeRaw=true", () => {
    expect(resolveFields(curated, raw, { includeRaw: true, defaultFields: ["id"] })).toBe(raw)
  })

  it("returns user-picked subset when fields[] provided", () => {
    expect(
      resolveFields(curated, raw, { fields: ["name"], defaultFields: ["id", "name"] }),
    ).toEqual({ name: "foo" })
  })

  it("returns default whitelist otherwise", () => {
    expect(resolveFields(curated, raw, { defaultFields: ["id", "name"] })).toEqual({
      id: "1",
      name: "foo",
    })
  })

  it("treats empty fields[] as fallthrough to default", () => {
    expect(resolveFields(curated, raw, { fields: [], defaultFields: ["id"] })).toEqual({
      id: "1",
    })
  })
})

describe("resolveFieldsList", () => {
  it("returns rawItems when includeRaw=true", () => {
    const raw = [{ a: 1 }, { a: 2 }]
    expect(
      resolveFieldsList([{ a: 1 }, { a: 2 }] as Array<Record<string, unknown>>, raw, {
        includeRaw: true,
        defaultFields: ["a"],
      }),
    ).toBe(raw)
  })

  it("applies fields[] override per row", () => {
    const items = [
      { id: "1", name: "a", extra: "x" },
      { id: "2", name: "b", extra: "y" },
    ]
    const out = resolveFieldsList(items, items, {
      fields: ["name"],
      defaultFields: ["id", "name", "extra"],
    })
    expect(out).toEqual([{ name: "a" }, { name: "b" }])
  })
})

describe("validateAttachment", () => {
  it("accepts a valid https URL", () => {
    expect(() => validateAttachment({ fileUrl: "https://drive.google.com/file/d/abc" }, 0))
      .not.toThrow()
  })

  it("accepts a valid http URL", () => {
    expect(() => validateAttachment({ fileUrl: "http://example.com/file.pdf" }, 0))
      .not.toThrow()
  })

  it("rejects empty string", () => {
    expect(() => validateAttachment({ fileUrl: "" }, 0))
      .toThrow(/non-empty string/)
  })

  it("rejects whitespace-only string", () => {
    expect(() => validateAttachment({ fileUrl: "   " }, 1))
      .toThrow(/non-empty string/)
  })

  it("rejects undefined", () => {
    expect(() => validateAttachment({ fileUrl: undefined }, 2))
      .toThrow(/non-empty string/)
  })

  it("rejects malformed URL", () => {
    expect(() => validateAttachment({ fileUrl: "not-a-url" }, 0))
      .toThrow(/valid http\(s\) URL/)
  })

  it("rejects non-http(s) protocol", () => {
    expect(() => validateAttachment({ fileUrl: "ftp://files.example.com/x" }, 0))
      .toThrow(/must use http or https/)
    expect(() => validateAttachment({ fileUrl: "javascript:alert(1)" }, 0))
      .toThrow(/must use http or https/)
  })

  it("includes the index in error messages", () => {
    expect(() => validateAttachment({ fileUrl: "" }, 3))
      .toThrow(/attachments\[3\]/)
  })
})
