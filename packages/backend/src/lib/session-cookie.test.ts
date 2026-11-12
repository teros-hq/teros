/**
 * Tests for the session cookie helpers (Req 6.6.1 — web session persistence).
 */

import { describe, expect, it } from "bun:test"
import type { IncomingMessage } from "http"
import {
  buildSessionCookie,
  buildSessionCookieClear,
  isSecureRequest,
  parseCookies,
  SESSION_COOKIE_NAME,
} from "./session-cookie"

function makeReq(opts?: {
  cookie?: string
  forwardedProto?: string
  encrypted?: boolean
}): IncomingMessage {
  return {
    headers: {
      ...(opts?.cookie !== undefined ? { cookie: opts.cookie } : {}),
      ...(opts?.forwardedProto !== undefined ? { "x-forwarded-proto": opts.forwardedProto } : {}),
    },
    socket: { encrypted: opts?.encrypted ?? false },
  } as unknown as IncomingMessage
}

describe("parseCookies", () => {
  it("returns empty map without a Cookie header", () => {
    expect(parseCookies(makeReq())).toEqual({})
  })

  it("parses a single cookie", () => {
    expect(parseCookies(makeReq({ cookie: "teros_session=tok123" }))).toEqual({
      teros_session: "tok123",
    })
  })

  it("parses multiple cookies and trims whitespace", () => {
    expect(parseCookies(makeReq({ cookie: "a=1; teros_session=tok; b=2" }))).toEqual({
      a: "1",
      teros_session: "tok",
      b: "2",
    })
  })

  it("keeps '=' inside values and decodes URI-encoded values", () => {
    expect(parseCookies(makeReq({ cookie: "a=x%3Dy=z" }))).toEqual({ a: "x=y=z" })
  })

  it("ignores malformed segments without '='", () => {
    expect(parseCookies(makeReq({ cookie: "garbage; a=1" }))).toEqual({ a: "1" })
  })

  it("keeps raw value when decodeURIComponent fails", () => {
    expect(parseCookies(makeReq({ cookie: "a=%E0%A4%A" }))).toEqual({ a: "%E0%A4%A" })
  })
})

describe("isSecureRequest", () => {
  it("true behind an https reverse proxy", () => {
    expect(isSecureRequest(makeReq({ forwardedProto: "https" }))).toBe(true)
  })

  it("uses the first hop of a multi-value X-Forwarded-Proto", () => {
    expect(isSecureRequest(makeReq({ forwardedProto: "https, http" }))).toBe(true)
    expect(isSecureRequest(makeReq({ forwardedProto: "http, https" }))).toBe(false)
  })

  it("false for plain http", () => {
    expect(isSecureRequest(makeReq({ forwardedProto: "http" }))).toBe(false)
    expect(isSecureRequest(makeReq())).toBe(false)
  })

  it("true for a direct TLS socket", () => {
    expect(isSecureRequest(makeReq({ encrypted: true }))).toBe(true)
  })
})

describe("buildSessionCookie", () => {
  it("sets the token with httpOnly + SameSite=Lax + Path=/ + Max-Age", () => {
    const cookie = buildSessionCookie("tok123", makeReq())
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok123`)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
    expect(cookie).toMatch(/Max-Age=\d+/)
  })

  it("adds Secure only on https requests", () => {
    expect(buildSessionCookie("t", makeReq({ forwardedProto: "https" }))).toContain("Secure")
    expect(buildSessionCookie("t", makeReq())).not.toContain("Secure")
  })

  it("URI-encodes the token", () => {
    expect(buildSessionCookie("a;b c", makeReq())).toContain(`${SESSION_COOKIE_NAME}=a%3Bb%20c`)
  })
})

describe("buildSessionCookieClear", () => {
  it("expires the cookie immediately", () => {
    const cookie = buildSessionCookieClear(makeReq())
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`)
    expect(cookie).toContain("Max-Age=0")
    expect(cookie).toContain("HttpOnly")
  })
})
