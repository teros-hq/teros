import { describe, expect, it } from 'bun:test'
import { sanitizeErrorMessage } from '../../src/services/agent-usage-pii-sanitizer'

describe('sanitizeErrorMessage', () => {
  it('returns undefined for null/undefined/empty inputs', () => {
    expect(sanitizeErrorMessage(undefined)).toBeUndefined()
    expect(sanitizeErrorMessage(null)).toBeUndefined()
    expect(sanitizeErrorMessage('')).toBeUndefined()
    expect(sanitizeErrorMessage('   ')).toBeUndefined()
  })

  it('redacts email addresses', () => {
    const out = sanitizeErrorMessage('User alice@example.com not found')
    expect(out).toBe('User [REDACTED_EMAIL] not found')
  })

  it('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.YQEMnEfA-2cf1ZS9SR5OZl-9SrwBOG7Yek7l7t5cyHk'
    const out = sanitizeErrorMessage(`Authorization failed: ${jwt}`)
    expect(out).toBe('Authorization failed: [REDACTED_JWT]')
  })

  it('redacts Bearer tokens', () => {
    const out = sanitizeErrorMessage('Bearer xxxxxxxxxxxx is invalid')
    expect(out).toContain('Bearer [REDACTED]')
  })

  it('redacts API key patterns', () => {
    const out = sanitizeErrorMessage('Invalid key sk-abcdefghijklmnopqrstuvwxyz')
    expect(out).toContain('[REDACTED_APIKEY]')
  })

  it('redacts Fireworks keys (fw_…) — the teros upstream secret (R8.5)', () => {
    const out = sanitizeErrorMessage('401 with key fw_3ZqAb9CdEf0GhIjKlMnOpQrStUvWx')
    expect(out).toContain('[REDACTED_APIKEY]')
    expect(out).not.toContain('fw_3ZqAb9CdEf0GhIjKlMnOpQrStUvWx')
  })

  it('redacts unix home paths', () => {
    const out = sanitizeErrorMessage('Cannot read /Users/alice/Desktop/secret.json')
    expect(out).toBe('Cannot read /[REDACTED_HOME]/Desktop/secret.json')
  })

  it('redacts IPv4 addresses', () => {
    const out = sanitizeErrorMessage('Cannot connect to 192.168.1.1:5432')
    expect(out).toBe('Cannot connect to [REDACTED_IP]:5432')
  })

  it('truncates to 1000 characters with ellipsis', () => {
    const longStr = 'x'.repeat(1500)
    const out = sanitizeErrorMessage(longStr)
    expect(out).toHaveLength(1000)
    expect(out!.endsWith('...')).toBe(true)
  })

  it('accepts Error objects (extracts .message)', () => {
    const err = new Error('Failed: user alice@example.com not found')
    const out = sanitizeErrorMessage(err)
    expect(out).toContain('[REDACTED_EMAIL]')
  })
})
