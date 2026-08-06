import { describe, expect, test } from 'bun:test';
import { TtlCache } from '../../src/lib/cache';

describe('TtlCache', () => {
  test('returns undefined for missing key', () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get('foo')).toBeUndefined();
  });

  test('returns value when key exists', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('foo', 'bar');
    expect(cache.get('foo')).toBe('bar');
  });

  test('expires entries after ttl', async () => {
    const cache = new TtlCache<number>(50);
    cache.set('k', 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.get('k')).toBeUndefined();
  });

  test('evicts oldest when reaching maxSize', () => {
    const cache = new TtlCache<number>(60_000, 3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  test('updating existing key does not evict', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 99);
    expect(cache.get('a')).toBe(99);
    expect(cache.get('b')).toBe(2);
  });

  test('clear empties cache', () => {
    const cache = new TtlCache<string>(1000);
    cache.set('x', 'y');
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
