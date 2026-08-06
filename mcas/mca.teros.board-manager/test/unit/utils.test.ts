/**
 * Tests puros de las helpers en src/tools/utils.ts.
 *
 * Las helpers son la capa de contrato del MCA: cualquier regresión aquí rompe
 * curación, paginación, resiliencia o fields-custom en las 27 tools al mismo
 * tiempo. Tests ligeros, sin dependencias del SDK ni backend.
 */

import { describe, expect, it } from 'bun:test';
import {
  paginate,
  pickFields,
  pickFieldsList,
  resolveFields,
  resolveFieldsList,
  withRetry,
  withTimeout,
} from '../../src/tools/utils';

describe('pickFields', () => {
  it('returns only the requested fields', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(pickFields(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('ignores requested fields not present in the object', () => {
    const obj = { a: 1 };
    expect(pickFields(obj, ['a', 'missing'])).toEqual({ a: 1 });
  });

  it('returns an empty object when no fields match', () => {
    expect(pickFields({ a: 1 }, ['b'])).toEqual({});
  });

  it('preserves falsy values (0, null, false, empty string)', () => {
    const obj = { zero: 0, nullish: null, flag: false, empty: '' };
    expect(pickFields(obj, ['zero', 'nullish', 'flag', 'empty'])).toEqual({
      zero: 0,
      nullish: null,
      flag: false,
      empty: '',
    });
  });
});

describe('pickFieldsList', () => {
  it('applies pickFields to each item in the list', () => {
    const list = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ];
    expect(pickFieldsList(list, ['a'])).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('returns an empty array for an empty input', () => {
    expect(pickFieldsList([], ['a'])).toEqual([]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 150 }, (_, i) => ({ id: i }));

  it('returns default limit (50) when no limit is provided', () => {
    const result = paginate(items);
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBeDefined();
  });

  it('respects custom limit within bounds', () => {
    const result = paginate(items, 10);
    expect(result.items).toHaveLength(10);
    expect(result.nextCursor).toBeDefined();
  });

  it('caps limit at the hard maximum (200)', () => {
    const result = paginate(items, 500);
    expect(result.items).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
  });

  it('clamps limit below 1 to 1', () => {
    const result = paginate(items, 0);
    expect(result.items).toHaveLength(1);
  });

  it('paginates through with cursor', () => {
    const page1 = paginate(items, 50);
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeDefined();

    const page2 = paginate(items, 50, page1.nextCursor);
    expect(page2.items).toHaveLength(50);
    expect((page2.items[0] as { id: number }).id).toBe(50);
  });

  it('omits nextCursor on the last page', () => {
    const result = paginate(items, 200, undefined);
    expect(result.items).toHaveLength(150);
    expect(result.nextCursor).toBeUndefined();
  });

  it('uses offset 0 when cursor is invalid', () => {
    const result = paginate(items, 10, 'not-a-valid-base64');
    expect(result.items).toHaveLength(10);
    expect((result.items[0] as { id: number }).id).toBe(0);
  });
});

describe('resolveFields', () => {
  const obj = { a: 1, b: 2, c: 3, internal: 'hidden' };
  const defaults = ['a', 'b', 'c'] as const;

  it('applies default fields when neither includeRaw nor fields are set', () => {
    expect(resolveFields(obj, { defaultFields: defaults })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('returns the full object when includeRaw=true', () => {
    expect(resolveFields(obj, { includeRaw: true, defaultFields: defaults })).toEqual(obj);
  });

  it('applies custom fields when provided (overrides default)', () => {
    expect(resolveFields(obj, { fields: ['a'], defaultFields: defaults })).toEqual({ a: 1 });
  });

  it('falls back to default when fields is an empty array', () => {
    expect(resolveFields(obj, { fields: [], defaultFields: defaults })).toEqual({
      a: 1,
      b: 2,
      c: 3,
    });
  });

  it('prefers includeRaw over fields when both are set', () => {
    expect(
      resolveFields(obj, { includeRaw: true, fields: ['a'], defaultFields: defaults }),
    ).toEqual(obj);
  });
});

describe('resolveFieldsList', () => {
  const items = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ];

  it('applies defaults across the list', () => {
    expect(resolveFieldsList(items, { defaultFields: ['a'] })).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('returns the full items when includeRaw=true', () => {
    expect(resolveFieldsList(items, { includeRaw: true, defaultFields: ['a'] })).toEqual(items);
  });

  it('applies custom fields across the list', () => {
    expect(
      resolveFieldsList(items, { fields: ['b'], defaultFields: ['a'] }),
    ).toEqual([{ b: 2 }, { b: 4 }]);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  it('rejects with a clear error when the timeout fires first', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 200));
    await expect(withTimeout(slow, 50, 'list_tasks')).rejects.toThrow(/Timeout.*list_tasks/);
  });
});

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return Promise.resolve('ok');
      },
      { retries: 2, delayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on failure and succeeds on subsequent attempts', async () => {
    // The SDK's `withRetry` only considers transient errors retryable by
    // default (5xx, timeout, network). Use an explicit `shouldRetry: () =>
    // true` via error.code to make the test deterministic with generic
    // errors. Mimics what a real 503 from the backend looks like.
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        if (calls < 3) {
          const err = new Error('transient') as Error & { status?: number };
          err.status = 503;
          return Promise.reject(err);
        }
        return Promise.resolve('ok');
      },
      { retries: 3, delayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws aggregated error after exhausting retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          const err = new Error('persistent') as Error & { status?: number };
          err.status = 503; // retryable per SDK default predicate
          return Promise.reject(err);
        },
        { retries: 2, delayMs: 1, label: 'list_tasks' },
      ),
    ).rejects.toThrow(/list_tasks failed after 3 attempts.*persistent/);
    expect(calls).toBe(3);
  });
});
