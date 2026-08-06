import { describe, expect, it } from 'bun:test'
import { INSTANCE_ID, sanitizeInstanceIdForFilename } from '../../src/lib/instance-id'

describe('INSTANCE_ID', () => {
  it('is a non-empty string at module load', () => {
    expect(typeof INSTANCE_ID).toBe('string')
    expect(INSTANCE_ID.length).toBeGreaterThan(0)
  })
})

describe('sanitizeInstanceIdForFilename', () => {
  it('keeps alphanumerics, dashes and underscores intact', () => {
    expect(sanitizeInstanceIdForFilename('node-A_1')).toBe('node-A_1')
  })

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeInstanceIdForFilename('pod/0:42@host')).toBe('pod_0_42_host')
  })

  it('handles whitespace and slashes', () => {
    expect(sanitizeInstanceIdForFilename('a b\tc/d')).toBe('a_b_c_d')
  })
})
