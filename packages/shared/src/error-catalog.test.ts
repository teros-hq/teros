import { describe, expect, it } from 'bun:test'
import { normalizeError, isUserFacingError, ERROR_CATALOG } from './error-catalog.js'

// ---------------------------------------------------------------------------
// Pattern matching — one case per catalog entry
// ---------------------------------------------------------------------------

describe('normalizeError — pattern matching', () => {
  it('MONGO_CONN_REFUSED: ECONNREFUSED on port 27017', () => {
    const r = normalizeError(new Error('connect ECONNREFUSED ::1:27017'))
    expect(r.patternId).toBe('MONGO_CONN_REFUSED')
    expect(r.errorType).toBe('network')
    expect(r.recoverable).toBe(true)
  })

  it('MONGO_CONN_REFUSED: dual-stack variant', () => {
    const r = normalizeError(
      new Error('connect ECONNREFUSED ::1:27017, connect ECONNREFUSED 127.0.0.1:27017'),
    )
    expect(r.patternId).toBe('MONGO_CONN_REFUSED')
  })

  it('CONN_REFUSED: generic (no port 27017)', () => {
    const r = normalizeError(new Error('connect ECONNREFUSED 10.0.0.1:6379'))
    expect(r.patternId).toBe('CONN_REFUSED')
    expect(r.errorType).toBe('network')
    expect(r.recoverable).toBe(true)
  })

  it('CONN_REFUSED: matched by error.code', () => {
    const err = Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' })
    const r = normalizeError(err)
    expect(r.patternId).toBe('CONN_REFUSED')
  })

  it('CONN_RESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const r = normalizeError(err)
    expect(r.patternId).toBe('CONN_RESET')
    expect(r.errorType).toBe('network')
  })

  it('DNS_RESOLUTION: ENOTFOUND', () => {
    const r = normalizeError(new Error('getaddrinfo ENOTFOUND api.example.com'))
    expect(r.patternId).toBe('DNS_RESOLUTION')
    expect(r.errorType).toBe('network')
  })

  it('DNS_RESOLUTION: EAI_AGAIN', () => {
    const err = Object.assign(new Error('lookup failed'), { code: 'EAI_AGAIN' })
    expect(normalizeError(err).patternId).toBe('DNS_RESOLUTION')
  })

  it('TIMEOUT: ETIMEDOUT', () => {
    const err = Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
    const r = normalizeError(err)
    expect(r.patternId).toBe('TIMEOUT')
    expect(r.errorType).toBe('network')
    expect(r.recoverable).toBe(true)
  })

  it('TIMEOUT: generic "timeout" word', () => {
    expect(normalizeError(new Error('Operation timeout after 30000ms')).patternId).toBe('TIMEOUT')
  })

  it('TIMEOUT: "timed out" phrasing (OperationTimeoutError message)', () => {
    expect(
      normalizeError(new Error('Operation "llm-stream" timed out after 60000ms')).patternId,
    ).toBe('TIMEOUT')
  })

  it('TIMEOUT: matches by error .name (OperationTimeoutError)', () => {
    const err = Object.assign(new Error('deadline exceeded'), { name: 'OperationTimeoutError' })
    expect(normalizeError(err).patternId).toBe('TIMEOUT')
  })

  it('AUTH_EXPIRED: token expired', () => {
    const r = normalizeError(new Error('OAuth token expired'))
    expect(r.patternId).toBe('AUTH_EXPIRED')
    expect(r.errorType).toBe('session')
    expect(r.recoverable).toBe(false)
  })

  it('AUTH_EXPIRED: statusCode 401', () => {
    const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    expect(normalizeError(err).patternId).toBe('AUTH_EXPIRED')
  })

  it('AUTH_EXPIRED: MCA_CALLBACK_TOKEN', () => {
    expect(normalizeError(new Error('MCA_CALLBACK_TOKEN invalid')).patternId).toBe('AUTH_EXPIRED')
  })

  it('PERMISSION_DENIED: EACCES', () => {
    const r = normalizeError(new Error('EACCES: permission denied'))
    expect(r.patternId).toBe('PERMISSION_DENIED')
    expect(r.errorType).toBe('validation')
    expect(r.recoverable).toBe(false)
  })

  it('PERMISSION_DENIED: EPERM', () => {
    const err = Object.assign(new Error('not permitted'), { code: 'EPERM' })
    expect(normalizeError(err).patternId).toBe('PERMISSION_DENIED')
  })

  it('FILE_NOT_FOUND: ENOENT', () => {
    const r = normalizeError(new Error("ENOENT: no such file '/tmp/foo'"))
    expect(r.patternId).toBe('FILE_NOT_FOUND')
    expect(r.errorType).toBe('validation')
    expect(r.recoverable).toBe(false)
  })

  it('JSON_PARSE: SyntaxError message', () => {
    const r = normalizeError(new SyntaxError('Unexpected token < in JSON at position 0'))
    expect(r.patternId).toBe('JSON_PARSE')
    expect(r.errorType).toBe('validation')
    expect(r.recoverable).toBe(true)
  })

  it('CONTEXT_WINDOW: prompt too long', () => {
    const r = normalizeError(new Error('prompt is too long: 210000 tokens > 200000 maximum'))
    expect(r.patternId).toBe('CONTEXT_WINDOW')
    expect(r.errorType).toBe('llm')
  })

  it('CONTEXT_WINDOW: context_length_exceeded', () => {
    expect(normalizeError(new Error('context_length_exceeded')).patternId).toBe('CONTEXT_WINDOW')
  })

  it('RATE_LIMIT: rate limit hit', () => {
    const r = normalizeError(new Error('rate limit exceeded'))
    expect(r.patternId).toBe('RATE_LIMIT')
    expect(r.errorType).toBe('llm')
    expect(r.recoverable).toBe(true)
  })

  it('RATE_LIMIT: statusCode 429', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 })
    expect(normalizeError(err).patternId).toBe('RATE_LIMIT')
  })

  it('LLM_SERVER_ERROR: 500', () => {
    const err = Object.assign(new Error('Internal server error'), { status: 500 })
    const r = normalizeError(err)
    expect(r.patternId).toBe('LLM_SERVER_ERROR')
    expect(r.errorType).toBe('llm')
    expect(r.recoverable).toBe(true)
  })

  it('TOOL_UNAVAILABLE: tool not found', () => {
    const r = normalizeError(new Error('tool not found: google_search'))
    expect(r.patternId).toBe('TOOL_UNAVAILABLE')
    expect(r.errorType).toBe('tool')
  })

  it('TOOL_UNAVAILABLE: NOT_READY', () => {
    expect(normalizeError(new Error('MCA NOT_READY')).patternId).toBe('TOOL_UNAVAILABLE')
  })

  it('TOOL_UNAVAILABLE: MCA crashed', () => {
    expect(normalizeError(new Error('mca crashed during execution')).patternId).toBe(
      'TOOL_UNAVAILABLE',
    )
  })

  it('FALLBACK: unknown error', () => {
    const r = normalizeError(new Error('something completely unexpected'))
    expect(r.patternId).toBe('FALLBACK')
    expect(r.errorType).toBe('unknown')
    expect(r.recoverable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('normalizeError — edge cases', () => {
  it('null input', () => {
    const r = normalizeError(null)
    expect(r.patternId).toBe('FALLBACK')
    expect(r.technicalMessage).toBe('Unknown error')
  })

  it('undefined input', () => {
    const r = normalizeError(undefined)
    expect(r.patternId).toBe('FALLBACK')
  })

  it('string input', () => {
    const r = normalizeError('ECONNREFUSED something')
    expect(r.patternId).toBe('CONN_REFUSED')
  })

  it('plain object with message + code', () => {
    const r = normalizeError({ message: 'fail', code: 'ETIMEDOUT' })
    expect(r.patternId).toBe('TIMEOUT')
  })

  it('plain object with status', () => {
    const r = normalizeError({ message: 'bad', status: 429 })
    expect(r.patternId).toBe('RATE_LIMIT')
  })

  it('number input → fallback', () => {
    const r = normalizeError(42)
    expect(r.patternId).toBe('FALLBACK')
  })

  it('userMessage never contains raw technical info', () => {
    const r = normalizeError(new Error('connect ECONNREFUSED ::1:27017'))
    expect(r.userMessage).not.toContain('ECONNREFUSED')
    expect(r.userMessage).not.toContain('27017')
    expect(r.technicalMessage).toContain('ECONNREFUSED')
  })
})

// ---------------------------------------------------------------------------
// Catalog invariants
// ---------------------------------------------------------------------------

describe('ERROR_CATALOG — invariants', () => {
  it('last entry is always FALLBACK', () => {
    const last = ERROR_CATALOG[ERROR_CATALOG.length - 1]
    expect(last.id).toBe('FALLBACK')
    expect(last.match({ message: '' })).toBe(true)
  })

  it('all IDs unique', () => {
    const ids = ERROR_CATALOG.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all patterns have non-empty defaultMessage and i18nKey', () => {
    for (const p of ERROR_CATALOG) {
      expect(p.defaultMessage.length).toBeGreaterThan(0)
      expect(p.i18nKey.length).toBeGreaterThan(0)
    }
  })

  it('first-match precedence: MONGO_CONN_REFUSED before CONN_REFUSED', () => {
    const r = normalizeError(new Error('connect ECONNREFUSED ::1:27017'))
    expect(r.patternId).toBe('MONGO_CONN_REFUSED')
  })
})

// ---------------------------------------------------------------------------
// User-facing errors — already-redacted messages are preserved, raw ones aren't
// ---------------------------------------------------------------------------

describe('normalizeError — user-facing errors are preserved', () => {
  it('preserves userMessage from an AgentError-like error (does not apply catalog)', () => {
    // technical message would match CONN_REFUSED, but userMessage wins
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:6379'), {
      userMessage: 'No puedo conectar con el modelo. Reintenta en unos segundos.',
    })
    const r = normalizeError(err)
    expect(r.userMessage).toBe('No puedo conectar con el modelo. Reintenta en unos segundos.')
    // technical message is still kept for logging
    expect(r.technicalMessage).toContain('ECONNREFUSED')
  })

  it('preserves userMessage from a HandlerError-like error even when no pattern matches', () => {
    const err = Object.assign(new Error('You cannot do that'), {
      code: 'ACCESS_DENIED',
      userMessage: 'You cannot do that',
    })
    expect(normalizeError(err).userMessage).toBe('You cannot do that')
  })

  it('a raw Error (no userMessage) is NOT user-facing and gets normalized', () => {
    expect(normalizeError(new Error('Something went wrong')).userMessage).toBe(
      'Ocurrió un error inesperado. Intenta de nuevo.',
    )
  })

  it('empty / whitespace userMessage falls back to the catalog', () => {
    const err = Object.assign(new Error('boom'), { userMessage: '   ' })
    expect(normalizeError(err).userMessage).toBe('Ocurrió un error inesperado. Intenta de nuevo.')
  })
})

describe('isUserFacingError', () => {
  it('true for an object with a non-empty userMessage', () => {
    expect(isUserFacingError({ userMessage: 'hola' })).toBe(true)
  })

  it('false for a raw Error, null, string and empty userMessage', () => {
    expect(isUserFacingError(new Error('raw'))).toBe(false)
    expect(isUserFacingError(null)).toBe(false)
    expect(isUserFacingError('userMessage')).toBe(false)
    expect(isUserFacingError({ userMessage: '' })).toBe(false)
    expect(isUserFacingError({ userMessage: 42 })).toBe(false)
  })
})
