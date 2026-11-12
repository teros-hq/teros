/**
 * Structural invariant (lint-as-test): every handler in `domains/admin-api/*`
 * MUST be behind an admin authorization gate. These handlers expose the highest
 * blast-radius operations in the platform — grant access, manage other users'
 * workspaces, change global feature flags. The gate is copy-pasted per file
 * (`requireAdmin`) or shared (`requireSystemAdmin`, `requireSuper`), so a single
 * forgotten call silently exposes an admin operation to any user.
 *
 * Verified at the time of writing: all 52 handlers across the 10 files call a
 * gate (handlers == gate-calls per file). This test freezes that property so a
 * new handler added without a gate fails CI instead of shipping a hole.
 *
 * Per-handler check (not per-file): each `return async function …` body must
 * contain a gate call. Splitting on the handler boundary means an ungated
 * handler cannot "borrow" the gate of its neighbour.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ADMIN_API_DIR = resolve(
  __dirname,
  '../../../packages/backend/src/handlers/domains/admin-api',
);

/** The recognised admin gates. `requireSuper` is stricter (super-only); all three
 * reject a plain user with FORBIDDEN. */
const GATE = /\b(?:requireAdmin|requireSuper|requireSystemAdmin)\s*\(/;

function adminApiFiles(): string[] {
  return readdirSync(ADMIN_API_DIR).filter(
    (f) => f.endsWith('.ts') && f !== 'index.ts',
  );
}

describe('admin-api authorization gate invariant (TER-447)', () => {
  it('every admin-api handler calls an admin gate', () => {
    const ungated: string[] = [];
    let handlerCount = 0;

    for (const file of adminApiFiles()) {
      const src = readFileSync(resolve(ADMIN_API_DIR, file), 'utf-8');
      // Each handler is `return async function <name>(ctx, …) { … }`. The chunk
      // for handler N runs until the next handler start (or EOF), so its gate
      // (if any) is the one inside N's own body.
      const handlerChunks = src.split(/return async function\s+/).slice(1);
      for (const chunk of handlerChunks) {
        const name = chunk.match(/^(\w+)/)?.[1] ?? '<anonymous>';
        handlerCount++;
        if (!GATE.test(chunk)) {
          ungated.push(`${file}:${name}`);
        }
      }
    }

    // Sanity: the split actually found the handlers (guards against a refactor
    // that changes the handler shape and makes this test pass vacuously).
    expect(handlerCount).toBeGreaterThan(30);
    expect(ungated).toEqual([]);
  });
});
