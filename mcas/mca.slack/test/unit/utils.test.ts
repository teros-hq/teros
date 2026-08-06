/**
 * Tests for `utils.ts` — field filtering, body sanitisation, retry wrapper.
 */

import { describe, expect, it } from 'bun:test';
import {
  pickFields,
  resolveFields,
  resolveFieldsList,
  sanitiseBody,
  sanitizeLimit,
  wrapSlackCall,
  wrapSlackMutation,
} from '../../src/tools/utils';
import { SlackApiError } from '../../src/tools/_slack-error';

describe('pickFields / resolveFields', () => {
  const sample = { id: 'C01', name: 'general', topic: 'chat', extra: 'noise' };
  const defaultFields = ['id', 'name'] as const;

  it('pickFields keeps only listed keys', () => {
    expect(pickFields(sample, ['id', 'name'])).toEqual({ id: 'C01', name: 'general' });
  });

  it('resolveFields default uses defaultFields', () => {
    expect(resolveFields(sample, sample, { defaultFields })).toEqual({
      id: 'C01',
      name: 'general',
    });
  });

  it('resolveFields with custom fields wins', () => {
    expect(resolveFields(sample, sample, { fields: ['topic'], defaultFields })).toEqual({
      topic: 'chat',
    });
  });

  it('resolveFields with includeRaw passes raw through', () => {
    const raw = { ...sample, deeply: { nested: 1 } };
    expect(resolveFields(sample, raw, { includeRaw: true, defaultFields })).toBe(raw);
  });

  it('resolveFieldsList applies the same logic per row', () => {
    const items = [sample, { id: 'C02', name: 'random', topic: 'misc' }];
    const out = resolveFieldsList(items, items, { defaultFields });
    expect(out).toEqual([
      { id: 'C01', name: 'general' },
      { id: 'C02', name: 'random' },
    ]);
  });
});

describe('sanitiseBody', () => {
  it('drops undefined and null entries by default', () => {
    expect(
      sanitiseBody({ a: 'x', b: undefined, c: null, d: 0, e: false }),
    ).toEqual({ a: 'x', d: 0, e: false });
  });

  it('keeps null when keepNull is set (clear-field semantics)', () => {
    expect(
      sanitiseBody({ a: 'x', b: undefined, c: null }, { keepNull: true }),
    ).toEqual({ a: 'x', c: null });
  });
});

describe('sanitizeLimit', () => {
  it('clamps within [min, max] and floors floats', () => {
    expect(sanitizeLimit(50, { max: 100, default: 20 })).toBe(50);
    expect(sanitizeLimit(0, { max: 100, default: 20 })).toBe(1);
    expect(sanitizeLimit(99999, { max: 100, default: 20 })).toBe(100);
    expect(sanitizeLimit(50.7, { max: 100, default: 20 })).toBe(50);
  });

  it('returns default for non-number inputs', () => {
    expect(sanitizeLimit(undefined, { max: 100, default: 20 })).toBe(20);
    expect(sanitizeLimit(NaN, { max: 100, default: 20 })).toBe(20);
    expect(sanitizeLimit('50' as any, { max: 100, default: 20 })).toBe(20);
  });

  it('respects custom min', () => {
    expect(sanitizeLimit(0, { min: 0, max: 10, default: 5 })).toBe(0);
  });
});

describe('wrapSlackCall (retry on transient)', () => {
  it('rethrows immediately on non-retryable error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw { code: 'invalid_auth' };
    };
    await expect(wrapSlackCall(fn, { retries: 5 })).rejects.toBeInstanceOf(SlackApiError);
    expect(calls).toBe(1);
  });

  it('retries on rate-limited then succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw { code: 'ratelimited' };
      return { ok: true };
    };
    const out = (await wrapSlackCall(fn, { retries: 3, initialDelayMs: 1 })) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('exhausts retries and rethrows', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw { status: 503 };
    };
    await expect(wrapSlackCall(fn, { retries: 2, initialDelayMs: 1 })).rejects.toBeInstanceOf(
      SlackApiError,
    );
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe('wrapSlackMutation (no retry)', () => {
  it('does not retry on retryable error', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw { code: 'ratelimited' };
    };
    await expect(wrapSlackMutation(fn)).rejects.toBeInstanceOf(SlackApiError);
    expect(calls).toBe(1);
  });

  it('passes through results when ok', async () => {
    const out = (await wrapSlackMutation(async () => ({ ok: 1 }))) as { ok: number };
    expect(out.ok).toBe(1);
  });
});
