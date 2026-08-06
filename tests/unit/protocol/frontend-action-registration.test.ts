/**
 * Invariant — every frontend WS action is registered in the backend (TER-463)
 *
 * The WsRouter routes `request` envelopes by a free-string `action` looked up in
 * a registry (no protocol enum gates them — `WsFrameworkMessageSchema.action` is
 * passthrough). So if the frontend emits `transport.request('domain.verb', …)`
 * for an action the backend never `router.register('domain.verb', …)`s, the call
 * fails at runtime with `UNKNOWN_ACTION` — silently, only when that code path runs.
 *
 * This lint-as-test reads both layers from source and asserts the frontend's
 * emitted-action set ⊆ the backend's registered-action set. It caught two latent
 * drifts when written: `board.move-my-task` (handler written, never registered)
 * and `board.set-channel-project` (frontend used the wrong domain prefix; the
 * handler is registered under `project.`).
 *
 * NOTE: this is the real cross-layer contract. The protocol-enum drift of the
 * same class (switch ⊆ z.enum on the internal MCA query path) is covered
 * separately by the query_conversations invariant (TER-444).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const ROOT = resolve(__dirname, '../../..');
const ACTION = /[a-z][a-z-]*\.[a-z][a-z-]*/; // domain.verb shape

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
      walk(p, acc);
    } else if (
      (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
      !/\.(test|spec)\.tsx?$/.test(e.name)
    ) {
      // Exclude test files: declaran acciones de fixture (ws-transport.test.ts emite
      // a.first/a.second) que no son tráfico real frontend→backend.
      acc.push(p);
    }
  }
  return acc;
}

/** All actions registered via `router.register('domain.verb', …)` (multi-line aware). */
function backendRegistered(): Set<string> {
  const set = new Set<string>();
  const re = new RegExp(`\\.register\\(\\s*["'\`](${ACTION.source})["'\`]`, 'g');
  for (const f of walk(resolve(ROOT, 'packages/backend/src'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) set.add(m[1]);
  }
  return set;
}

/** Actions emitted via `transport.request('domain.verb', …)`, plus a count of
 *  non-literal `.request(variable)` call sites that can't be checked statically. */
function frontendEmitted(): { actions: Map<string, string>; dynamic: number } {
  const actions = new Map<string, string>();
  let dynamic = 0;
  const reLiteral = new RegExp(`\\.request\\(\\s*["'\`](${ACTION.source})["'\`]`, 'g');
  const reDynamic = /\.request\(\s*[A-Za-z_$]/g; // first arg is an identifier, not a string
  for (const f of walk(resolve(ROOT, 'packages/app/src'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(reLiteral)) {
      if (!actions.has(m[1])) actions.set(m[1], f.replace(`${ROOT}/`, ''));
    }
    dynamic += [...src.matchAll(reDynamic)].length;
  }
  return { actions, dynamic };
}

describe('WS action registration — frontend ⊆ backend', () => {
  const registered = backendRegistered();
  const { actions: emitted, dynamic } = frontendEmitted();

  it('extracts a sane number of actions from both layers', () => {
    // Floors guard against the regex silently breaking (returning [] = false green).
    expect(registered.size).toBeGreaterThan(150);
    expect(emitted.size).toBeGreaterThan(80);
  });

  it('every action the frontend emits is registered in some backend domain', () => {
    const violations = [...emitted.entries()]
      .filter(([action]) => !registered.has(action))
      .map(([action, file]) => `${action}  (emitted in ${file})`);

    expect(violations).toEqual([]);
  });

  it('reports — but does not fail on — dynamically-named request() call sites', () => {
    // These carry the action in a variable, so they can't be checked statically.
    // Surfaced (not silently dropped) so a growing blind spot is visible.
    console.log(`[TER-463] ${dynamic} dynamic transport.request(<var>) call site(s) not statically checkable`);
    expect(dynamic).toBeGreaterThanOrEqual(0);
  });
});
