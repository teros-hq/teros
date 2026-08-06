/**
 * Tests puros de las helpers en src/tools/utils.ts (board-runner).
 * Paridad reducida con los del board-manager / Core.
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
    expect(pickFields({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('preserves falsy values', () => {
    const obj = { zero: 0, nullish: null, flag: false, empty: '' };
    expect(pickFields(obj, ['zero', 'nullish', 'flag', 'empty'])).toEqual(obj);
  });
});

describe('pickFieldsList', () => {
  it('applies pickFields to each item in the list', () => {
    expect(
      pickFieldsList(
        [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        ['a'],
      ),
    ).toEqual([{ a: 1 }, { a: 3 }]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: i }));

  it('returns default limit (50) when no limit is provided', () => {
    const result = paginate(items);
    expect(result.items).toHaveLength(50);
    expect(result.nextCursor).toBeDefined();
  });

  it('paginates through with cursor', () => {
    const p1 = paginate(items, 40);
    const p2 = paginate(items, 40, p1.nextCursor);
    expect(p2.items).toHaveLength(40);
    expect((p2.items[0] as { id: number }).id).toBe(40);
  });

  it('omits nextCursor on the last page', () => {
    const result = paginate(items, 200);
    expect(result.items).toHaveLength(120);
    expect(result.nextCursor).toBeUndefined();
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

  it('applies custom fields when provided', () => {
    expect(resolveFields(obj, { fields: ['a'], defaultFields: defaults })).toEqual({ a: 1 });
  });
});

describe('resolveFieldsList', () => {
  it('applies defaults across the list', () => {
    expect(
      resolveFieldsList(
        [
          { a: 1, b: 2 },
          { a: 3, b: 4 },
        ],
        { defaultFields: ['a'] },
      ),
    ).toEqual([{ a: 1 }, { a: 3 }]);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    expect(await withTimeout(Promise.resolve(42), 100)).toBe(42);
  });

  it('rejects with the label when the timeout fires first', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 200));
    await expect(withTimeout(slow, 50, 'get_my_task')).rejects.toThrow(/Timeout.*get_my_task/);
  });
});

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    expect(await withRetry(() => Promise.resolve('ok'), { retries: 2, delayMs: 1 })).toBe('ok');
  });

  it('retries on failure and succeeds on subsequent attempts', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls++;
        return calls < 2 ? Promise.reject(new Error('ETIMEDOUT')) : Promise.resolve('ok');
      },
      { retries: 3, delayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws aggregated error after exhausting retries', async () => {
    await expect(
      withRetry(() => Promise.reject(new Error('persistent')), {
        retries: 2,
        delayMs: 1,
        label: 'get_my_tasks',
      }),
    ).rejects.toThrow(/get_my_tasks failed after 3 attempts/);
  });
});
