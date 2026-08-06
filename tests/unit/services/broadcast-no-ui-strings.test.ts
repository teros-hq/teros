/**
 * Invariant — broadcast payloads carry data, not UI strings (TER-449)
 *
 * The layer contract (CLAUDE.md): the backend emits structured DATA and the
 * frontend composes the human-facing sentence. If a `broadcastTo*` payload ships
 * a pre-rendered UI string (e.g. `message: "Workspace 'X' archived"`), every
 * client is forced to display the backend's wording, i18n breaks, and the
 * payload stops being a stable data contract.
 *
 * This lint-as-test scans every `broadcastTo{User,Workspace,Channel,Topic}` call
 * site and flags a presentation key (`message`/`text`/`toast`/`notification`)
 * assigned a *string literal* (a capitalised value — a sentence). Data fields
 * (`name`, `description`, `title` carrying real values, or any key set from a
 * variable) are not literals and don't match.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const BACKEND_SRC = resolve(__dirname, '../../../packages/backend/src');
const BROADCAST = /broadcastTo(?:User|Workspace|Channel|Topic)\s*\(/g;
// A presentation key assigned a capitalised string literal inside the payload.
// `(?<!\.)` and `(?<!\?\s)` exclude non-key matches that can fall inside the
// scan window: a property access in a ternary (`err.message : 'Failed …'`) is
// not a payload key — the string never leaves the backend via the broadcast.
const UI_STRING = /(?<![.?]\s{0,4})\b(?:message|text|toast|notification)\s*:\s*["'`][A-Z]/;
const WINDOW = 500; // chars after the call opener — payloads are small objects

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walk(p, acc);
    } else if (e.name.endsWith('.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

function scan() {
  const sites: string[] = [];
  const violations: string[] = [];
  for (const f of walk(BACKEND_SRC)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(BROADCAST)) {
      sites.push(`${f}:${m.index}`);
      const window = src.slice(m.index!, m.index! + WINDOW);
      if (UI_STRING.test(window)) {
        const line = src.slice(0, m.index).split('\n').length;
        violations.push(`${f.replace(`${BACKEND_SRC}/`, '')}:${line}`);
      }
    }
  }
  return { sites, violations };
}

describe('broadcast payloads — data, not UI strings', () => {
  const { sites, violations } = scan();

  it('finds a sane number of broadcast call sites (regex still works)', () => {
    expect(sites.length).toBeGreaterThan(50);
  });

  it('no broadcast payload ships a pre-rendered UI string', () => {
    expect(violations).toEqual([]);
  });
});
