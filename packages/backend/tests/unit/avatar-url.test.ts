/**
 * buildAvatarUrl — shared, idempotent avatar URL resolver.
 *
 * Regression: avatar values were resolved by 9 duplicated helpers, several of
 * which unconditionally prepended the static base. When the avatar upload stored
 * an absolute URL, those copies double-wrapped it into `<base>/<base>/<file>`
 * → 404 → broken avatar on reload. This pins the absolute-URL passthrough.
 */

import { describe, expect, it } from 'bun:test'
import { buildAvatarUrl } from '../../src/lib/avatar-url'

describe('buildAvatarUrl', () => {
  it('returns undefined for empty input', () => {
    expect(buildAvatarUrl()).toBeUndefined()
    expect(buildAvatarUrl('')).toBeUndefined()
  })

  it('returns an absolute http(s) URL unchanged (regression: no double-wrap)', () => {
    const abs = 'http://localhost:10001/static/agent_iria-avatar-410a8e6f.png'
    expect(buildAvatarUrl(abs)).toBe(abs)
    const https = 'https://cdn.example.com/a.png'
    expect(buildAvatarUrl(https)).toBe(https)
  })

  it('returns a root-relative path unchanged', () => {
    expect(buildAvatarUrl('/static/x.png')).toBe('/static/x.png')
  })

  it('prepends the static base to a bare filename (storage convention)', () => {
    const out = buildAvatarUrl('iria.png')
    expect(out).toBeDefined()
    expect(out?.endsWith('/iria.png')).toBe(true)
    // never double-wrapped
    expect((out?.match(/https?:\/\//g) ?? []).length).toBeLessThanOrEqual(1)
  })
})
