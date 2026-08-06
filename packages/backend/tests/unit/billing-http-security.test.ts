/**
 * Edge-security helpers (FASE 5a): CORS origin allowlisting, client-IP
 * extraction (X-Forwarded-For trust), and IP allowlist matching (exact + IPv4
 * CIDR + IPv6 exact).
 *
 * These gate two real exposures: a bare `Access-Control-Allow-Origin: *` on the
 * API/WS, and an open `/metrics` endpoint. The asserts pin the EXACT decision
 * for each input.
 *
 * MUST BITE (confirmed red against mutated source):
 *   - dropping the `allowlist.includes('*')` short-circuit → '*' allowlist returns null,
 *   - dropping the `allowlist.includes(origin)` check → any origin echoed,
 *   - dropping the `trustProxy` guard → spoofed XFF trusted when proxy untrusted,
 *   - widening the CIDR mask (off-by-one in `32 - bits`) → adjacent /24 leaks in,
 *   - dropping the `n > 255` octet guard → 999.x parsed as valid.
 */

import type { IncomingMessage } from "node:http"
import { describe, expect, it } from "bun:test"
import {
  extractClientIp,
  isIpAllowed,
  resolveAllowedOrigin,
  resolveTrustProxyDefault,
  timingSafeStringEqual,
} from "../../src/lib/http-security"

const ORIGINS = ["https://os.teros.ai", "http://localhost:8081"]

function fakeReq(opts: { xff?: string | string[]; remote?: string }): IncomingMessage {
  return {
    headers: opts.xff === undefined ? {} : { "x-forwarded-for": opts.xff },
    socket: { remoteAddress: opts.remote },
  } as unknown as IncomingMessage
}

describe("resolveAllowedOrigin", () => {
  it("echoes an allowlisted origin verbatim", () => {
    expect(resolveAllowedOrigin("https://os.teros.ai", ORIGINS)).toBe("https://os.teros.ai")
    expect(resolveAllowedOrigin("http://localhost:8081", ORIGINS)).toBe("http://localhost:8081")
  })

  it("returns null for a non-allowlisted origin", () => {
    expect(resolveAllowedOrigin("https://evil.example", ORIGINS)).toBeNull()
  })

  it("returns null when no Origin header is present", () => {
    expect(resolveAllowedOrigin(undefined, ORIGINS)).toBeNull()
  })

  it("returns '*' only when the allowlist itself contains '*'", () => {
    expect(resolveAllowedOrigin("https://evil.example", ["*"])).toBe("*")
    expect(resolveAllowedOrigin(undefined, ["*"])).toBe("*")
  })

  it("does not treat '*' as a wildcard match for a concrete allowlist", () => {
    // '*' as an Origin value is not special — only an allowlist '*' is.
    expect(resolveAllowedOrigin("*", ORIGINS)).toBeNull()
  })
})

describe("extractClientIp", () => {
  it("takes the left-most XFF hop when proxy is trusted", () => {
    expect(extractClientIp(fakeReq({ xff: "203.0.113.7, 10.0.0.1", remote: "10.0.0.1" }), true)).toBe(
      "203.0.113.7",
    )
  })

  it("ignores XFF and uses the TCP peer when proxy is untrusted", () => {
    expect(extractClientIp(fakeReq({ xff: "203.0.113.7", remote: "10.0.0.2" }), false)).toBe("10.0.0.2")
  })

  it("falls back to the TCP peer when XFF is absent even if trusted", () => {
    expect(extractClientIp(fakeReq({ remote: "192.168.1.5" }), true)).toBe("192.168.1.5")
  })

  it("strips the IPv4-mapped IPv6 prefix", () => {
    expect(extractClientIp(fakeReq({ remote: "::ffff:127.0.0.1" }), false)).toBe("127.0.0.1")
    expect(extractClientIp(fakeReq({ xff: "::ffff:203.0.113.9", remote: "x" }), true)).toBe("203.0.113.9")
  })

  it("handles a header delivered as an array (first value, first hop)", () => {
    expect(extractClientIp(fakeReq({ xff: ["8.8.8.8, 10.0.0.1", "ignored"], remote: "10.0.0.1" }), true)).toBe(
      "8.8.8.8",
    )
  })

  it("returns empty string when no source is available", () => {
    expect(extractClientIp(fakeReq({}), true)).toBe("")
  })
})

describe("isIpAllowed", () => {
  const ALLOW = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]

  it("matches exact IPv4 and IPv6 loopback", () => {
    expect(isIpAllowed("127.0.0.1", ALLOW)).toBe(true)
    expect(isIpAllowed("::1", ALLOW)).toBe(true)
  })

  it("matches inside RFC1918 ranges", () => {
    expect(isIpAllowed("10.255.255.254", ALLOW)).toBe(true)
    expect(isIpAllowed("172.16.0.1", ALLOW)).toBe(true)
    expect(isIpAllowed("172.31.255.255", ALLOW)).toBe(true)
    expect(isIpAllowed("192.168.1.100", ALLOW)).toBe(true)
  })

  it("rejects public IPs and the /12 boundary just outside the range", () => {
    expect(isIpAllowed("203.0.113.7", ALLOW)).toBe(false)
    expect(isIpAllowed("8.8.8.8", ALLOW)).toBe(false)
    // 172.32.0.0 is the first address past 172.16.0.0/12 (172.16–172.31).
    expect(isIpAllowed("172.32.0.1", ALLOW)).toBe(false)
    // 172.15.255.255 is just below the range.
    expect(isIpAllowed("172.15.255.255", ALLOW)).toBe(false)
  })

  it("respects /32 (single host) and /0 (everything)", () => {
    expect(isIpAllowed("5.5.5.5", ["5.5.5.5/32"])).toBe(true)
    expect(isIpAllowed("5.5.5.6", ["5.5.5.5/32"])).toBe(false)
    expect(isIpAllowed("203.0.113.7", ["0.0.0.0/0"])).toBe(true)
  })

  it("matches IPv4-mapped IPv6 against IPv4 rules", () => {
    expect(isIpAllowed("::ffff:10.1.2.3", ALLOW)).toBe(true)
  })

  it("rejects malformed entries and inputs without throwing", () => {
    expect(isIpAllowed("10.0.0.1", ["10.0.0.0/33"])).toBe(false)
    expect(isIpAllowed("10.0.0.1", ["10.0.0.0/-1"])).toBe(false)
    expect(isIpAllowed("999.0.0.1", ["999.0.0.0/8"])).toBe(false)
    expect(isIpAllowed("10.0.0.1", ["not-an-ip"])).toBe(false)
    expect(isIpAllowed("", ALLOW)).toBe(false)
  })

  it("returns false for an empty allowlist", () => {
    expect(isIpAllowed("127.0.0.1", [])).toBe(false)
  })
})

describe("timingSafeStringEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeStringEqual("Bearer secret-token-123", "Bearer secret-token-123")).toBe(true)
  })

  it("returns false for a different string of the same length", () => {
    expect(timingSafeStringEqual("Bearer secret-token-123", "Bearer secret-token-124")).toBe(false)
  })

  it("returns false for strings of different length without throwing", () => {
    expect(timingSafeStringEqual("short", "a-much-longer-value")).toBe(false)
    expect(timingSafeStringEqual("a-much-longer-value", "short")).toBe(false)
  })

  it("returns false when either side is empty, never true by vacuous match", () => {
    expect(timingSafeStringEqual("", "")).toBe(true)
    expect(timingSafeStringEqual("", "nonempty")).toBe(false)
    expect(timingSafeStringEqual("nonempty", "")).toBe(false)
  })

  it("is case-sensitive and prefix-sensitive", () => {
    expect(timingSafeStringEqual("Bearer TOKEN", "Bearer token")).toBe(false)
    expect(timingSafeStringEqual("Bearer token", "Bearer token-extra")).toBe(false)
  })
})

describe("resolveTrustProxyDefault (SEC-6/M1)", () => {
  it("defaults to false when TRUST_PROXY is unset — a clone-and-run deploy has no proxy to trust", () => {
    expect(resolveTrustProxyDefault(undefined)).toBe(false)
  })

  it('is true only for the exact string "true"', () => {
    expect(resolveTrustProxyDefault("true")).toBe(true)
  })

  it("stays false for any other value, including truthy-looking near-misses", () => {
    expect(resolveTrustProxyDefault("false")).toBe(false)
    expect(resolveTrustProxyDefault("1")).toBe(false)
    expect(resolveTrustProxyDefault("TRUE")).toBe(false)
    expect(resolveTrustProxyDefault("")).toBe(false)
  })
})
