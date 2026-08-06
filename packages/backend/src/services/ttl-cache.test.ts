/**
 * Tests for the TTL cache + minute normalisation (A4.5 / TER-675).
 *
 * `now` is injected so the TTL boundary is asserted deterministically — the
 * value must be served WITHIN the window and gone AT/after expiry.
 */

import { describe, expect, it } from "bun:test"
import { floorToMinute, TtlCache } from "./ttl-cache.js"

describe("TtlCache", () => {
  it("serves a value within the TTL and evicts at expiry", () => {
    let now = 1_000
    const cache = new TtlCache<string>(60_000, () => now)
    cache.set("k", "v")

    now = 1_000 + 59_999 // still inside the 60s window
    expect(cache.get("k")).toBe("v")

    now = 1_000 + 60_000 // exactly at expiry → gone
    expect(cache.get("k")).toBeUndefined()
    expect(cache.size).toBe(0) // evicted on the miss
  })

  it("returns undefined for an unknown key", () => {
    const cache = new TtlCache<number>(1000, () => 0)
    expect(cache.get("nope")).toBeUndefined()
  })

  it("a later set refreshes the expiry", () => {
    let now = 0
    const cache = new TtlCache<string>(100, () => now)
    cache.set("k", "a")
    now = 80
    cache.set("k", "b") // refresh, new expiry = 180
    now = 150
    expect(cache.get("k")).toBe("b") // would be expired under the first set
  })
})

describe("floorToMinute", () => {
  it("floors an instant to the start of its minute", () => {
    // Two admins 40s apart within the same minute collapse to one key.
    const a = Date.parse("2026-07-08T12:34:20.000Z")
    const b = Date.parse("2026-07-08T12:34:59.999Z")
    expect(floorToMinute(a)).toBe(Date.parse("2026-07-08T12:34:00.000Z"))
    expect(floorToMinute(b)).toBe(Date.parse("2026-07-08T12:34:00.000Z"))
    expect(floorToMinute(a)).toBe(floorToMinute(b))
  })

  it("a different minute yields a different key", () => {
    const a = Date.parse("2026-07-08T12:34:59Z")
    const c = Date.parse("2026-07-08T12:35:00Z")
    expect(floorToMinute(a)).not.toBe(floorToMinute(c))
  })
})
