/**
 * Invariant — `Vary: Origin` is emitted on EVERY response, including requests
 * without an Origin header.
 *
 * Prod incident 2026-10-01: MCA icons at /static/mcas/<id>/icon.svg are fetched
 * two ways from the same URL — no-cors <img> (IconTile/HeaderRow → no Origin
 * header → no ACAO) and CORS fetch() (McaIcon → Origin → ACAO reflected). The
 * responses are publicly cacheable (Cache-Control: public, max-age=86400).
 * When `Vary: Origin` was only sent alongside ACAO, the no-Origin variant was
 * cached without any Vary key, so a shared cache could serve it to a later
 * CORS fetch — the browser rejects it as "No 'Access-Control-Allow-Origin'
 * header" and every renderer falls back to the '?' initials.
 *
 * The fix is structural (one setHeader moved out of the `if (allowedOrigin)`
 * branch). A functional test would need the full handler harness; this test
 * pins the structure instead, same approach as the token-compare invariant.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const HTTP_SERVER = resolve(__dirname, "../../src/bootstrap/http-server.ts")

function source(): string {
  return readFileSync(HTTP_SERVER, "utf-8")
}

describe("http-server Vary: Origin invariant (CORS cache poisoning)", () => {
  it("sets Vary: Origin exactly once", () => {
    const matches = source().match(/res\.setHeader\('Vary', 'Origin'\)/g)
    expect(matches?.length).toBe(1)
  })

  it("sets Vary: Origin BEFORE the allowedOrigin branch (unconditional, not inside it)", () => {
    const src = source()
    const varyPos = src.indexOf("res.setHeader('Vary', 'Origin')")
    const branchPos = src.indexOf("if (allowedOrigin) {")
    expect(varyPos).toBeGreaterThan(-1)
    expect(branchPos).toBeGreaterThan(-1)
    // The setHeader must precede the branch — if it ever moves back inside the
    // `if`, requests without Origin get no Vary and the cache poisoning
    // window reopens.
    expect(varyPos).toBeLessThan(branchPos)
  })

  it("still reflects ACAO only for allowlisted origins (hardening intact)", () => {
    const src = source()
    expect(src).toContain("resolveAllowedOrigin(req.headers.origin, config.security.corsAllowedOrigins)")
    expect(src).toContain("res.setHeader('Access-Control-Allow-Origin', allowedOrigin)")
    // Credentials header stays gated on non-'*' ACAO (Req 6.6.1).
    expect(src).toContain("res.setHeader('Access-Control-Allow-Credentials', 'true')")
  })
})
