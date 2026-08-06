/**
 * End-to-end session lifecycle test
 *
 * Verifies that destroySession() cleans ALL registered stores so that a
 * subsequent login as a different user sees no contamination.
 *
 * Uses lightweight mock stores (no React Native dependency) to exercise
 * the SessionManager + StoreRegistry infrastructure.
 */

import { describe, expect, it, beforeEach } from 'bun:test';

import {
  storeRegistry,
  destroySession,
} from '../';

// ── Mock stores ───────────────────────────────────────────────────────────────

function createMockStore(name: string) {
  let value = 0;
  return {
    name,
    getValue: () => value,
    setValue: (v: number) => { value = v; },
    resetSession: () => { value = 0; },
  };
}

describe('Session lifecycle with mock stores', () => {
  beforeEach(async () => {
    // Clear any previously-registered stores between tests
    await destroySession();
  });

  it('destroySession resets all registered stores', async () => {
    const chat = createMockStore('chat');
    const workspace = createMockStore('workspace');
    const navbar = createMockStore('navbar');

    storeRegistry.register('chat', chat);
    storeRegistry.register('workspace', workspace);
    storeRegistry.register('navbar', navbar);

    // Populate state
    chat.setValue(42);
    workspace.setValue(99);
    navbar.setValue(7);

    expect(chat.getValue()).toBe(42);
    expect(workspace.getValue()).toBe(99);
    expect(navbar.getValue()).toBe(7);

    // Destroy session
    await destroySession();

    // All stores reset
    expect(chat.getValue()).toBe(0);
    expect(workspace.getValue()).toBe(0);
    expect(navbar.getValue()).toBe(0);
  });

  it('destroySession continues even if one store throws', async () => {
    const storeA = createMockStore('a');
    const storeB: typeof storeA & { resetSession: () => void } = {
      ...createMockStore('b'),
      resetSession: () => { throw new Error('boom'); },
    };
    const storeC = createMockStore('c');

    storeRegistry.register('a', storeA);
    storeRegistry.register('b', storeB);
    storeRegistry.register('c', storeC);

    storeA.setValue(1);
    storeC.setValue(3);

    // Should not throw — continues resetting other stores
    await destroySession();

    expect(storeA.getValue()).toBe(0);
    expect(storeC.getValue()).toBe(0);
  });

  it('no contamination after session destroy + new session', async () => {
    const chat = createMockStore('chat');
    storeRegistry.register('chat', chat);

    // Simulate user A session
    chat.setValue(100);
    await destroySession();

    // Simulate user B session starting fresh
    expect(chat.getValue()).toBe(0);
    chat.setValue(200);
    expect(chat.getValue()).toBe(200);
  });
});
