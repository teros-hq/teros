import { describe, expect, it } from 'bun:test';
import { TimeoutError, withRetry, withTimeout } from '../src/retry';

describe('withTimeout', () => {
  it('resolves when fn finishes before the timeout', async () => {
    const result = await withTimeout(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    }, 100);
    expect(result).toBe('ok');
  });

  it('rejects with TimeoutError when fn exceeds the deadline', async () => {
    let caught: unknown;
    try {
      await withTimeout(() => new Promise((r) => setTimeout(r, 200)), 30);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    expect((caught as TimeoutError).message).toContain('30ms');
  });

  it('propagates fn errors without wrapping', async () => {
    const err = new Error('boom');
    let caught: unknown;
    try {
      await withTimeout(async () => {
        throw err;
      }, 100);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });

  it('skips the timer when ms <= 0', async () => {
    const result = await withTimeout(async () => 'fast', 0);
    expect(result).toBe('fast');
  });
});

describe('withRetry', () => {
  it('returns immediately if fn succeeds on first attempt', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'first';
    });
    expect(result).toBe('first');
    expect(calls).toBe(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
          throw err;
        }
        return 'recovered';
      },
      { initialDelayMs: 1 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('gives up after max retries and throws the last error', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          const err = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
          throw err;
        },
        { retries: 2, initialDelayMs: 1 },
      );
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect((caught as Error).message).toContain('ETIMEDOUT');
  });

  it('does NOT retry on 4xx errors by default', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await withRetry(async () => {
        calls++;
        const err = Object.assign(new Error('Bad Request'), { status: 400 });
        throw err;
      });
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(1);
    expect((caught as Error).message).toBe('Bad Request');
  });

  it('retries on TimeoutError', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new TimeoutError(100);
        return 'done';
      },
      { initialDelayMs: 1 },
    );
    expect(calls).toBe(2);
    expect(result).toBe('done');
  });

  it('supports custom shouldRetry predicate', async () => {
    let calls = 0;
    const customError = new Error('rate-limited');
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          calls++;
          throw customError;
        },
        {
          retries: 1,
          initialDelayMs: 1,
          shouldRetry: (err) => (err as Error).message.includes('rate-limited'),
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(calls).toBe(2);
    expect(caught).toBe(customError);
  });

  it('exponential backoff doubles delays (smoke test)', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    try {
      await withRetry(
        async () => {
          timestamps.push(Date.now());
          calls++;
          const err = Object.assign(new Error('5xx'), { status: 503 });
          throw err;
        },
        { retries: 2, initialDelayMs: 20, backoff: 'exponential' },
      );
    } catch {
      // expected
    }
    expect(calls).toBe(3);
    // Deltas: approx 20, 40 (exponential). Allow ±15 ms noise for scheduler jitter.
    const delta1 = timestamps[1]! - timestamps[0]!;
    const delta2 = timestamps[2]! - timestamps[1]!;
    expect(delta1).toBeGreaterThanOrEqual(10);
    expect(delta2).toBeGreaterThanOrEqual(delta1);
  });

  it('caps delay at maxDelayMs', async () => {
    const timestamps: number[] = [];
    let calls = 0;
    try {
      await withRetry(
        async () => {
          timestamps.push(Date.now());
          calls++;
          const err = Object.assign(new Error('5xx'), { status: 500 });
          throw err;
        },
        { retries: 2, initialDelayMs: 1000, maxDelayMs: 50 },
      );
    } catch {
      // expected
    }
    expect(calls).toBe(3);
    // Delta should be clamped near maxDelayMs, not 1000ms
    const delta = timestamps[1]! - timestamps[0]!;
    expect(delta).toBeLessThan(200);
  });
});
