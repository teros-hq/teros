/**
 * Tests for HTTP edge-security helpers (FASE 5a + Req 3.1.5 + Req 4.1.1).
 *
 * Covers:
 * - resolveAllowedOrigin: CORS origin allowlisting
 * - isOriginAllowed: anti-CSRF Origin/Referer validation (Req 3.1.5)
 * - extractClientIp: client IP extraction with/without trustProxy
 * - isIpAllowed: IP allowlist matching (exact + CIDR + loopback)
 * - timingSafeStringEqual: constant-time string comparison
 * - resolveTrustProxyDefault: env parsing
 * - buildHstsHeader: HSTS header value construction (Req 4.1.1)
 * - shouldSetHsts: HSTS gating based on X-Forwarded-Proto (Req 4.1.1)
 */

import { describe, expect, it } from 'bun:test'
import {
  buildHstsHeader,
  extractClientIp,
  isIpAllowed,
  isOriginAllowed,
  resolveAllowedOrigin,
  resolveTrustProxyDefault,
  withAppOrigin,
  shouldSetHsts,
  timingSafeStringEqual,
} from './http-security'
import type { IncomingMessage } from 'node:http'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ALLOWLIST = [
  'https://os.teros.ai',
  'http://localhost:8081',
  'http://localhost:19006',
]

// ---------------------------------------------------------------------------
// resolveAllowedOrigin
// ---------------------------------------------------------------------------

describe('resolveAllowedOrigin', () => {
  it('returns the origin verbatim when it is in the allowlist', () => {
    expect(resolveAllowedOrigin('https://os.teros.ai', ALLOWLIST)).toBe('https://os.teros.ai')
    expect(resolveAllowedOrigin('http://localhost:8081', ALLOWLIST)).toBe('http://localhost:8081')
  })

  it('returns null when the origin is not in the allowlist', () => {
    expect(resolveAllowedOrigin('https://evil.example.com', ALLOWLIST)).toBeNull()
  })

  it('returns null when origin is undefined', () => {
    expect(resolveAllowedOrigin(undefined, ALLOWLIST)).toBeNull()
  })

  it('returns "*" when the allowlist contains "*"', () => {
    expect(resolveAllowedOrigin('https://anything.com', ['*'])).toBe('*')
    expect(resolveAllowedOrigin(undefined, ['*'])).toBe('*')
  })
})

// ---------------------------------------------------------------------------
// isOriginAllowed (Req 3.1.5 — anti-CSRF)
// ---------------------------------------------------------------------------

describe('isOriginAllowed (Req 3.1.5 — anti-CSRF)', () => {
  describe('with a concrete allowlist', () => {
    it('returns true when Origin header matches an allowlisted origin', () => {
      expect(isOriginAllowed('https://os.teros.ai', undefined, ALLOWLIST)).toBe(true)
      expect(isOriginAllowed('http://localhost:8081', undefined, ALLOWLIST)).toBe(true)
    })

    it('returns false when Origin header is not in the allowlist', () => {
      expect(isOriginAllowed('https://evil.example.com', undefined, ALLOWLIST)).toBe(false)
    })

    it('falls back to Referer when Origin is absent', () => {
      expect(isOriginAllowed(undefined, 'https://os.teros.ai/dashboard', ALLOWLIST)).toBe(true)
      expect(isOriginAllowed(undefined, 'http://localhost:8081/settings', ALLOWLIST)).toBe(true)
    })

    it('extracts origin from Referer URL (strips path/query)', () => {
      expect(isOriginAllowed(undefined, 'https://os.teros.ai/agents/123?tab=chat', ALLOWLIST)).toBe(true)
    })

    it('returns false when Referer origin is not in the allowlist', () => {
      expect(isOriginAllowed(undefined, 'https://evil.example.com/exploit', ALLOWLIST)).toBe(false)
    })

    it('returns false when neither Origin nor Referer is present', () => {
      expect(isOriginAllowed(undefined, undefined, ALLOWLIST)).toBe(false)
    })

    it('returns false when Referer is malformed', () => {
      expect(isOriginAllowed(undefined, 'not-a-url', ALLOWLIST)).toBe(false)
      expect(isOriginAllowed(undefined, '', ALLOWLIST)).toBe(false)
    })

    it('prefers Origin over Referer when both are present', () => {
      // Origin is allowlisted, Referer is not → should pass (Origin wins)
      expect(isOriginAllowed('https://os.teros.ai', 'https://evil.example.com', ALLOWLIST)).toBe(true)
      // Origin is not allowlisted, Referer is → should fail (Origin wins)
      expect(isOriginAllowed('https://evil.example.com', 'https://os.teros.ai', ALLOWLIST)).toBe(false)
    })
  })

  describe('with a wildcard allowlist', () => {
    it('returns true regardless of Origin or Referer', () => {
      expect(isOriginAllowed('https://anything.com', undefined, ['*'])).toBe(true)
      expect(isOriginAllowed(undefined, undefined, ['*'])).toBe(true)
      expect(isOriginAllowed(undefined, 'https://evil.example.com', ['*'])).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles empty string origin as absent (falls through to Referer)', () => {
      // An empty string is falsy in the `if (origin)` check, so it falls through
      expect(isOriginAllowed('', 'https://os.teros.ai/path', ALLOWLIST)).toBe(true)
    })

    it('handles Referer with port normalization', () => {
      expect(isOriginAllowed(undefined, 'http://localhost:8081/app', ALLOWLIST)).toBe(true)
    })

    it('rejects Origin that differs only by scheme', () => {
      expect(isOriginAllowed('http://os.teros.ai', undefined, ALLOWLIST)).toBe(false)
    })

    it('rejects Origin that differs by port', () => {
      expect(isOriginAllowed('https://os.teros.ai:8443', undefined, ALLOWLIST)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// extractClientIp
// ---------------------------------------------------------------------------

describe('extractClientIp', () => {
  function mockReq(headers: Record<string, string | string[]>, remoteAddress?: string): IncomingMessage {
    return {
      headers,
      socket: { remoteAddress },
    } as unknown as IncomingMessage
  }

  it('uses X-Forwarded-For when trustProxy is true', () => {
    const req = mockReq({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, '10.0.0.1')
    expect(extractClientIp(req, true)).toBe('203.0.113.5')
  })

  it('ignores X-Forwarded-For when trustProxy is false', () => {
    const req = mockReq({ 'x-forwarded-for': '203.0.113.5' }, '127.0.0.1')
    expect(extractClientIp(req, false)).toBe('127.0.0.1')
  })

  it('falls back to socket.remoteAddress when XFF is absent', () => {
    const req = mockReq({}, '192.168.1.100')
    expect(extractClientIp(req, true)).toBe('192.168.1.100')
  })

  it('normalizes IPv4-mapped IPv6 addresses', () => {
    const req = mockReq({}, '::ffff:127.0.0.1')
    expect(extractClientIp(req, false)).toBe('127.0.0.1')
  })

  it('handles array-form X-Forwarded-For header', () => {
    const req = mockReq({ 'x-forwarded-for': ['203.0.113.10', '10.0.0.1'] }, '10.0.0.1')
    expect(extractClientIp(req, true)).toBe('203.0.113.10')
  })
})

// ---------------------------------------------------------------------------
// isIpAllowed
// ---------------------------------------------------------------------------

describe('isIpAllowed', () => {
  const IP_ALLOWLIST = ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12']

  it('matches exact IPs', () => {
    expect(isIpAllowed('127.0.0.1', IP_ALLOWLIST)).toBe(true)
    expect(isIpAllowed('::1', IP_ALLOWLIST)).toBe(true)
  })

  it('matches IPs within CIDR ranges', () => {
    expect(isIpAllowed('10.0.100.50', IP_ALLOWLIST)).toBe(true)
    expect(isIpAllowed('172.16.5.10', IP_ALLOWLIST)).toBe(true)
    expect(isIpAllowed('172.31.255.255', IP_ALLOWLIST)).toBe(true)
  })

  it('rejects IPs outside CIDR ranges', () => {
    expect(isIpAllowed('11.0.0.1', IP_ALLOWLIST)).toBe(false)
    expect(isIpAllowed('172.32.0.1', IP_ALLOWLIST)).toBe(false)
    expect(isIpAllowed('8.8.8.8', IP_ALLOWLIST)).toBe(false)
  })

  it('rejects empty IP', () => {
    expect(isIpAllowed('', IP_ALLOWLIST)).toBe(false)
  })

  it('normalizes IPv4-mapped IPv6 before matching', () => {
    expect(isIpAllowed('::ffff:127.0.0.1', IP_ALLOWLIST)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// timingSafeStringEqual
// ---------------------------------------------------------------------------

describe('timingSafeStringEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeStringEqual('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different strings of same length', () => {
    expect(timingSafeStringEqual('abc123', 'abc124')).toBe(false)
  })

  it('returns false for strings of different length', () => {
    expect(timingSafeStringEqual('abc', 'abc123')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveTrustProxyDefault
// ---------------------------------------------------------------------------

describe('resolveTrustProxyDefault', () => {
  it('returns true only for explicit "true"', () => {
    expect(resolveTrustProxyDefault('true')).toBe(true)
  })

  it('returns false for undefined', () => {
    expect(resolveTrustProxyDefault(undefined)).toBe(false)
  })

  it('returns false for other values', () => {
    expect(resolveTrustProxyDefault('false')).toBe(false)
    expect(resolveTrustProxyDefault('1')).toBe(false)
    expect(resolveTrustProxyDefault('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildHstsHeader (Req 4.1.1 — HSTS)
// ---------------------------------------------------------------------------

describe('buildHstsHeader (Req 4.1.1 — HSTS)', () => {
  it('builds a basic max-age header', () => {
    expect(buildHstsHeader(31536000, false, false)).toBe('max-age=31536000')
  })

  it('appends includeSubDomains when true', () => {
    expect(buildHstsHeader(31536000, true, false)).toBe('max-age=31536000; includeSubDomains')
  })

  it('appends preload when true', () => {
    expect(buildHstsHeader(31536000, false, true)).toBe('max-age=31536000; preload')
  })

  it('appends both includeSubDomains and preload when both are true', () => {
    expect(buildHstsHeader(31536000, true, true)).toBe('max-age=31536000; includeSubDomains; preload')
  })

  it('omits both directives when both are false', () => {
    expect(buildHstsHeader(0, false, false)).toBe('max-age=0')
  })
})

// ---------------------------------------------------------------------------
// shouldSetHsts (Req 4.1.1 — HSTS)
// ---------------------------------------------------------------------------

describe('shouldSetHsts (Req 4.1.1 — HSTS)', () => {
  function mockReq(headers: Record<string, string | string[]>): IncomingMessage {
    return { headers, socket: {} } as unknown as IncomingMessage
  }

  it('returns true when trustProxy is true and X-Forwarded-Proto is https', () => {
    const req = mockReq({ 'x-forwarded-proto': 'https' })
    expect(shouldSetHsts(req, true)).toBe(true)
  })

  it('returns false when trustProxy is true but X-Forwarded-Proto is http', () => {
    const req = mockReq({ 'x-forwarded-proto': 'http' })
    expect(shouldSetHsts(req, true)).toBe(false)
  })

  it('returns false when trustProxy is true but X-Forwarded-Proto is absent', () => {
    const req = mockReq({})
    expect(shouldSetHsts(req, true)).toBe(false)
  })

  it('returns false when trustProxy is false, even if X-Forwarded-Proto is https', () => {
    const req = mockReq({ 'x-forwarded-proto': 'https' })
    expect(shouldSetHsts(req, false)).toBe(false)
  })

  it('is case-insensitive for the proto value', () => {
    const req = mockReq({ 'x-forwarded-proto': 'HTTPS' })
    expect(shouldSetHsts(req, true)).toBe(true)
  })

  it('trims whitespace in the proto value', () => {
    const req = mockReq({ 'x-forwarded-proto': '  https  ' })
    expect(shouldSetHsts(req, true)).toBe(true)
  })

  it('handles array-form X-Forwarded-Proto header (uses first entry)', () => {
    const req = mockReq({ 'x-forwarded-proto': ['https', 'http'] })
    expect(shouldSetHsts(req, true)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// withAppOrigin (CORSAPP)
// ---------------------------------------------------------------------------

describe('withAppOrigin', () => {
  const defaults = ['https://os.teros.ai', 'http://localhost:8081', 'http://localhost:19006']

  it('[CORSAPP-AC-1] appends the APP_URL origin to the default list', () => {
    const list = withAppOrigin(defaults, 'http://localhost:10002')
    expect(list).toEqual([...defaults, 'http://localhost:10002'])
  })

  it('[CORSAPP-AC-2] keeps an explicit list and never duplicates the app origin', () => {
    expect(withAppOrigin(['https://a.example'], 'https://a.example/app/')).toEqual(['https://a.example'])
    expect(withAppOrigin(['https://a.example'], 'https://b.example')).toEqual(['https://a.example', 'https://b.example'])
  })

  it('[CORSAPP-AC-3] leaves the list unchanged for *, unset or malformed APP_URL', () => {
    expect(withAppOrigin(['*'], 'http://localhost:10002')).toEqual(['*'])
    expect(withAppOrigin(defaults, undefined)).toEqual(defaults)
    expect(withAppOrigin(defaults, 'not a url')).toEqual(defaults)
  })
})
