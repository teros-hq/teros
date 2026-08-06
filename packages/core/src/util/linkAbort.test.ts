/**
 * linkAbort tests (Phase 2.1 — TER-348 foundation).
 *
 * Mirror of the inline tests in `packages/backend/tests/unit/http-client-signal.test.ts`,
 * now sitting next to the canonical source. Verifies the helper in
 * isolation from HttpClient's wiring.
 */

import { describe, expect, it } from 'bun:test';
import { linkAbort } from './linkAbort';

describe('linkAbort', () => {
  it('is a no-op when parent signal is undefined', () => {
    const child = new AbortController();
    linkAbort(child, undefined);
    expect(child.signal.aborted).toBe(false);
  });

  it('aborts child synchronously when parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort('parent-already-done');
    const child = new AbortController();
    linkAbort(child, parent.signal);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('parent-already-done');
  });

  it('forwards future aborts from parent to child', () => {
    const parent = new AbortController();
    const child = new AbortController();
    linkAbort(child, parent.signal);
    expect(child.signal.aborted).toBe(false);
    parent.abort('fires-later');
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('fires-later');
  });

  it('is one-way: child abort does NOT propagate to parent', () => {
    const parent = new AbortController();
    const child = new AbortController();
    linkAbort(child, parent.signal);
    child.abort('child-only');
    expect(parent.signal.aborted).toBe(false);
  });

  it('listener is `once: true` — repeated parent aborts are idempotent', () => {
    const parent = new AbortController();
    const child = new AbortController();
    linkAbort(child, parent.signal);
    parent.abort('first');
    // Second abort is a no-op on AbortController by spec.
    parent.abort('second');
    expect(child.signal.reason).toBe('first');
  });

  it('supports chaining via multiple linkAbort calls (lockAC → turnAC → stepAC)', () => {
    const lockAC = new AbortController();
    const turnAC = new AbortController();
    const stepAC = new AbortController();
    linkAbort(turnAC, lockAC.signal);
    linkAbort(stepAC, turnAC.signal);
    expect(stepAC.signal.aborted).toBe(false);
    lockAC.abort('shutdown');
    expect(turnAC.signal.aborted).toBe(true);
    expect(stepAC.signal.aborted).toBe(true);
    expect(stepAC.signal.reason).toBe('shutdown');
  });
});
