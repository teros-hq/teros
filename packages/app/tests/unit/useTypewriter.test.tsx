/**
 * Tests for `useTypewriter`.
 *
 * Strategy: polyfill `window.matchMedia` and `requestAnimationFrame` on
 * `globalThis` BEFORE importing the hook, then drive the rAF queue
 * manually so we can step the loop deterministically. Render via
 * `react-test-renderer.act` and read the displayed string from the
 * single text child of the probe component.
 *
 * Covers (in order):
 *   1. Snap when `prefers-reduced-motion: reduce`.
 *   2. Snap when `active=false` from the start.
 *   3. Progressive streaming when `active=true`.
 *   4. `everActive` keeps draining after `active` flips false mid-stream.
 *   5. Backend rewrote/truncated text (shorter targetText → snap).
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import * as React from 'react';

// ── rAF + matchMedia polyfill ───────────────────────────────────────────────

const rafQueue: Array<(t: number) => void> = [];
let now = 0;
let mediaMatches = false;

const matchMediaImpl = (q: string) => ({
  matches: q.includes('reduce') ? mediaMatches : false,
  media: q,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => true,
});

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
;(globalThis as any).window = { matchMedia: matchMediaImpl };
;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
;(globalThis as any).cancelAnimationFrame = (_id: number) => {};

// IMPORTANT: import AFTER polyfills so `useReducedMotion` sees `window`.
import TestRenderer from 'react-test-renderer';
import { useTypewriter } from '../../src/hooks/useTypewriter';

// ── helpers ─────────────────────────────────────────────────────────────────

function Probe({ text, active }: { text: string; active: boolean }) {
  const out = useTypewriter(text, active);
  return React.createElement('span', null, out);
}

function readText(root: any): string {
  const json = root.toJSON();
  const child = json && json.children && json.children[0];
  return typeof child === 'string' ? child : '';
}

function flushRaf(ticks: number, dtMs = 30) {
  for (let i = 0; i < ticks; i++) {
    const drain = rafQueue.splice(0, rafQueue.length);
    now += dtMs;
    TestRenderer.act(() => {
      for (const cb of drain) cb(now);
    });
  }
}

beforeEach(() => {
  rafQueue.length = 0;
  now = 0;
  mediaMatches = false;
});

// ── tests ───────────────────────────────────────────────────────────────────

describe('useTypewriter', () => {
  it('snaps immediately when prefers-reduced-motion: reduce', () => {
    mediaMatches = true;
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'hello', active: true }),
      );
    });
    expect(readText(root)).toBe('hello');
  });

  it('snaps when active=false from the start', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'hello world', active: false }),
      );
    });
    expect(readText(root)).toBe('hello world');
    expect(rafQueue.length).toBe(0); // no rAF scheduled when snapping
  });

  it('streams progressively when active=true', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'hello world', active: true }),
      );
    });
    // Initial state is empty string (active true, no reduced motion).
    expect(readText(root)).toBe('');
    expect(rafQueue.length).toBeGreaterThan(0);
    // Drain a few ticks — chunk should grow but not snap to full length.
    flushRaf(2);
    const partial = readText(root);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThanOrEqual('hello world'.length);
    expect('hello world'.startsWith(partial)).toBe(true);
    // Drain enough ticks to reach the end (catchUpTicks default = 40).
    flushRaf(80);
    expect(readText(root)).toBe('hello world');
  });

  it('keeps draining after active flips false mid-stream (everActive)', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'hello world', active: true }),
      );
    });
    flushRaf(1);
    const before = readText(root);
    expect(before.length).toBeGreaterThan(0);
    expect(before).not.toBe('hello world');
    // Flip active=false but keep same targetText. Hook MUST NOT snap.
    TestRenderer.act(() => {
      root.update(
        React.createElement(Probe, { text: 'hello world', active: false }),
      );
    });
    // Still partial — no snap on the re-render itself.
    expect(readText(root)).toBe(before);
    // Continue draining: the rAF loop keeps revealing.
    flushRaf(80);
    expect(readText(root)).toBe('hello world');
  });

  it('snaps when targetText becomes shorter than current displayed', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'hello world long', active: true }),
      );
    });
    flushRaf(80);
    expect(readText(root)).toBe('hello world long');
    // Backend rewrote to a shorter string — should snap to the new value.
    TestRenderer.act(() => {
      root.update(
        React.createElement(Probe, { text: 'hi', active: true }),
      );
    });
    expect(readText(root)).toBe('hi');
  });

  it('snaps when backend rewrites to a non-prefix string of equal or greater length', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'Hello', active: true }),
      );
    });
    // Drain partial — displayed should be a prefix of "Hello", not the full text yet.
    flushRaf(1);
    const partial = readText(root);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan('Hello'.length);
    // Re-render with longer, NON-prefix string — must snap (not animate over stale text).
    TestRenderer.act(() => {
      root.update(
        React.createElement(Probe, { text: 'World!!', active: true }),
      );
    });
    expect(readText(root)).toBe('World!!');
  });

  it('continues animating when rewrite is still a valid prefix extension', () => {
    let root: any;
    TestRenderer.act(() => {
      root = TestRenderer.create(
        React.createElement(Probe, { text: 'Hello', active: true }),
      );
    });
    flushRaf(1);
    const partial = readText(root);
    expect('Hello'.startsWith(partial)).toBe(true);
    // Rewrite to a longer string where current displayed is still a prefix — NO snap.
    TestRenderer.act(() => {
      root.update(
        React.createElement(Probe, { text: 'Hello world', active: true }),
      );
    });
    // Right after rewrite, displayed must still be the partial (no snap to full).
    expect(readText(root)).toBe(partial);
    expect(readText(root)).not.toBe('Hello world');
    // Then keep animating to the new target.
    flushRaf(80);
    expect(readText(root)).toBe('Hello world');
  });
});
