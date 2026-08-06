/**
 * Upstream status-page indicator mapping (TER-616/§C9, R9).
 *
 * The fetch/cache path is covered by the smoke against the real status feeds;
 * here we pin the pure Statuspage.io indicator → health-enum mapping, including
 * the unknown fallback that keeps a malformed/absent feed from throwing.
 */

import { describe, expect, it } from "bun:test"
import { mapStatuspageIndicator } from "../../src/services/upstream-status"

describe("mapStatuspageIndicator (R9)", () => {
  it("maps the Statuspage.io indicators to upstream health", () => {
    expect(mapStatuspageIndicator("none")).toBe("operational")
    expect(mapStatuspageIndicator("minor")).toBe("degraded")
    expect(mapStatuspageIndicator("major")).toBe("partial_outage")
    expect(mapStatuspageIndicator("critical")).toBe("major_outage")
    expect(mapStatuspageIndicator("maintenance")).toBe("maintenance")
  })

  it("falls back to unknown for an unrecognised / absent indicator", () => {
    expect(mapStatuspageIndicator("garbage")).toBe("unknown")
    expect(mapStatuspageIndicator(undefined)).toBe("unknown")
    expect(mapStatuspageIndicator(null)).toBe("unknown")
    expect(mapStatuspageIndicator(42)).toBe("unknown")
  })
})
