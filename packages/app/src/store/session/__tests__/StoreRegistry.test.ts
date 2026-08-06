/**
 * Tests for StoreRegistry, createSessionStore, and SessionManager
 *
 * Covers:
 * - Store registration and resetAll
 * - createSessionStore auto-registration
 * - Error resilience (continues resetting even if one store throws)
 */

import { describe, expect, it, beforeEach, vi } from 'bun:test';

// ── Tested modules ─────────────────────────────────────────────────────────
import {
  storeRegistry,
  createSessionStore,
  destroySession,
} from '../';

// ── StoreRegistry Tests ─────────────────────────────────────────────────────

describe('StoreRegistry', () => {
  beforeEach(() => {
    // Reset the singleton registry between tests by overwriting every
    // registered store with a no-op.  There is no unregister API.
    for (const name of storeRegistry.getRegisteredStores()) {
      storeRegistry.register(name, { resetSession: () => {} });
    }
  });

  it('registers a store and lists it', () => {
    const store = { resetSession: () => {} };
    storeRegistry.register('test-store', store);

    expect(storeRegistry.getRegisteredStores()).toContain('test-store');
  });

  it('calls resetSession() on all registered stores', async () => {
    const store1 = { resetSession: vi.fn() };
    const store2 = { resetSession: vi.fn() };

    storeRegistry.register('store1', store1);
    storeRegistry.register('store2', store2);

    await storeRegistry.resetAll();

    expect(store1.resetSession).toHaveBeenCalledTimes(1);
    expect(store2.resetSession).toHaveBeenCalledTimes(1);
  });

  it('continues resetting even if one store throws', async () => {
    const store1 = { resetSession: vi.fn().mockRejectedValue(new Error('fail')) };
    const store2 = { resetSession: vi.fn() };

    storeRegistry.register('store1', store1);
    storeRegistry.register('store2', store2);

    await storeRegistry.resetAll();

    // store2 still gets reset even though store1 threw
    expect(store2.resetSession).toHaveBeenCalledTimes(1);
  });

  it('warns when replacing an already-registered store', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store1 = { resetSession: () => {} };
    const store2 = { resetSession: () => {} };

    storeRegistry.register('dup-store', store1);
    storeRegistry.register('dup-store', store2);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('already registered'),
    );
    warnSpy.mockRestore();
  });
});

// ── createSessionStore Tests ────────────────────────────────────────────────

describe('createSessionStore', () => {
  it('automatically registers the store in the registry', async () => {
    const store = createSessionStore('auto-store', (set) => ({
      value: 0,
      resetSession: () => set({ value: 0 } as any),
    }));

    expect(storeRegistry.getRegisteredStores()).toContain('auto-store');

    // Verify the store works
    (store as any).setState({ value: 42 });
    expect((store as any).getState().value).toBe(42);

    // Verify resetSession works via registry
    await storeRegistry.resetAll();
    expect((store as any).getState().value).toBe(0);
  });

  it('creates a functional Zustand store', () => {
    const store = createSessionStore('func-store', (set) => ({
      count: 0,
      increment: () => set((state: any) => ({ count: state.count + 1 }) as any),
      resetSession: () => set({ count: 0 } as any),
    }));

    expect((store as any).getState().count).toBe(0);
    (store as any).getState().increment();
    expect((store as any).getState().count).toBe(1);
  });
});

// ── SessionManager Tests ────────────────────────────────────────────────────

describe('destroySession', () => {
  it('resets all registered stores', async () => {
    const store = createSessionStore('destroy-test', (set) => ({
      data: 'hello',
      resetSession: () => set({ data: '' } as any),
    }));

    (store as any).setState({ data: 'world' });
    expect((store as any).getState().data).toBe('world');

    await destroySession();

    expect((store as any).getState().data).toBe('');
  });
});
