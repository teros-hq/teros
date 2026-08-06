/**
 * Unit tests for `withRetry` (R1 step 3).
 *
 * Uses an injected `sleep` mock instead of fake timers — keeps the test
 * deterministic and free of bun:test timer-mocking quirks.
 */

import { describe, expect, it, mock } from 'bun:test'
import { withRetry } from '../../src/lib/with-retry'

describe('withRetry', () => {
  it('returns ok on the first successful attempt without sleeping', async () => {
    const sleep = mock(async (_ms: number) => undefined)
    const result = await withRetry(async () => 42, {
      maxAttempts: 3,
      baseDelayMs: 100,
      sleep,
    })
    expect(result).toEqual({ ok: true, value: 42, attempts: 1 })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries until success and reports the attempt count', async () => {
    const sleep = mock(async (_ms: number) => undefined)
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('try again')
        return 'done'
      },
      { maxAttempts: 5, baseDelayMs: 10, sleep },
    )
    expect(result).toEqual({ ok: true, value: 'done', attempts: 3 })
    expect(sleep).toHaveBeenCalledTimes(2) // sleeps between attempts 1→2 and 2→3
  })

  it('exhausts after maxAttempts and returns the last error', async () => {
    const sleep = mock(async (_ms: number) => undefined)
    const result = await withRetry(
      async () => {
        throw new Error('always')
      },
      { maxAttempts: 3, baseDelayMs: 10, sleep },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.attempts).toBe(3)
      expect((result.lastError as Error).message).toBe('always')
    }
    // Sleeps only between attempts, NOT after the last failed one.
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('applies exponential backoff (base, base×2, base×4, …)', async () => {
    const delays: number[] = []
    const sleep = mock(async (ms: number) => {
      delays.push(ms)
    })
    await withRetry(
      async () => {
        throw new Error('boom')
      },
      { maxAttempts: 4, baseDelayMs: 100, sleep },
    )
    // Between 4 attempts there are 3 sleeps: 100, 200, 400.
    expect(delays).toEqual([100, 200, 400])
  })

  it('invokes onAttemptFail with the error and 1-indexed attempt number', async () => {
    const sleep = mock(async (_ms: number) => undefined)
    const onAttemptFail = mock((_err: unknown, _attempt: number) => undefined)
    await withRetry(
      async () => {
        throw new Error('nope')
      },
      { maxAttempts: 3, baseDelayMs: 1, sleep, onAttemptFail },
    )
    expect(onAttemptFail).toHaveBeenCalledTimes(3)
    expect(onAttemptFail.mock.calls[0][1]).toBe(1)
    expect(onAttemptFail.mock.calls[1][1]).toBe(2)
    expect(onAttemptFail.mock.calls[2][1]).toBe(3)
  })

  it('does NOT call onAttemptFail on successful attempt', async () => {
    const sleep = mock(async (_ms: number) => undefined)
    const onAttemptFail = mock((_err: unknown, _attempt: number) => undefined)
    await withRetry(async () => 'ok', {
      maxAttempts: 3,
      baseDelayMs: 1,
      sleep,
      onAttemptFail,
    })
    expect(onAttemptFail).not.toHaveBeenCalled()
  })
})
