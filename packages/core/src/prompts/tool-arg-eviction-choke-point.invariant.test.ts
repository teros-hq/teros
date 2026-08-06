/**
 * Structural (lint-as-test) guards for TER-707 / CTX-016: the tool-arg
 * elision projection must be the ONLY path by which messages leave the
 * session store for the turn pipeline, and no adapter may re-implement its
 * own local truncation on top of it.
 *
 * G1 — choke point: every `.getMessagesForLLM(` call site in `packages/core/src`
 * must be on the allowlist below. Anything else is a new caller that bypassed
 * `TurnDriver.loadProjectedMessages`, and therefore bypassed the projection.
 *
 * G2 — no local re-truncation: no `*Adapter.ts` may import the deleted
 * `openrouter-toolarg` helper (or a re-implementation of it), or slice/
 * substring a tool-args string by hand — the class of regression that
 * shipped as the original #398 patch.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CORE_SRC = join(import.meta.dir, '..');

/** Requires the leading `.` so `... via getMessagesForLLM()` in a COMMENT
 *  (ConversationManager.ts) does not false-positive (review-2 F1 — this
 *  broke CI in the pre-absorption draft of this guard). */
const CALL_SITE_RE = /\.getMessagesForLLM\(/g;

/** Paths relative to `packages/core/src`. Each entry needs a reason: */
const G1_ALLOWLIST = new Set<string>([
  // The sole choke point: loadProjectedMessages wraps the raw load with
  // INV-1 remediation AND the tool-arg projection before returning.
  'conversation/TurnDriver.ts',
  // Crash-recovery boot-time reconciliation needs the raw (unprojected)
  // window — it re-persists synthesized orphans, not an outbound prompt.
  'conversation/TurnReconciler.ts',
  // Definition of getMessagesForLLM itself, plus its deprecated wrapper.
  'session/SessionStore.ts',
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('tool-arg-eviction — choke point guards (TER-707 / CTX-016)', () => {
  it('G1: has core/src files to scan', () => {
    expect(walkTsFiles(CORE_SRC).length).toBeGreaterThan(0);
  });

  it('G1: every .getMessagesForLLM( call site is on the allowlist', () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(CORE_SRC)) {
      const rel = relative(CORE_SRC, file);
      if (G1_ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, 'utf-8');
      const matches = src.match(CALL_SITE_RE);
      if (matches) {
        offenders.push(`${rel} (${matches.length} call site(s))`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        [
          'New .getMessagesForLLM( call site(s) outside the G1 allowlist:',
          ...offenders,
          '',
          'Messages must flow through TurnDriver.loadProjectedMessages so the',
          'tool-arg elision projection runs before they reach the turn',
          'pipeline. If this is a deliberate new caller that needs the RAW',
          '(unprojected) window, add it to G1_ALLOWLIST here with a comment',
          'explaining why raw access is safe for that caller.',
        ].join('\n'),
      );
    }
  });

  it('G1: loadProjectedMessages is the method that actually projects', () => {
    const src = readFileSync(join(CORE_SRC, 'conversation/TurnDriver.ts'), 'utf-8');
    const start = src.indexOf('private async loadProjectedMessages(');
    expect(start).toBeGreaterThan(-1);
    // Method body ends at the first top-level `\n  }` after the signature —
    // good enough for a source-level guard on a single, non-nested method.
    const end = src.indexOf('\n  }', start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('.getMessagesForLLM(');
    expect(body).toContain('evictOversizedToolArgs(');
  });

  it('G2: no *Adapter.ts imports the deleted openrouter-toolarg helper', () => {
    // Matches an actual `import ... from '.../openrouter-toolarg'` specifier
    // — NOT a comment mentioning tool-arg-eviction.ts by name (adapters are
    // expected to reference it in prose, e.g. OpenRouterLLMAdapter's comment
    // pointing at the new choke point).
    const importRe = /from\s+['"][^'"]*openrouter-toolarg['"]/;
    const llmDir = join(CORE_SRC, 'llm');
    const offenders: string[] = [];
    for (const entry of readdirSync(llmDir)) {
      if (!entry.endsWith('Adapter.ts')) continue;
      const src = readFileSync(join(llmDir, entry), 'utf-8');
      if (importRe.test(src)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('G2: no *Adapter.ts hand-slices a tool-args string (the #398 regression class)', () => {
    // Matches e.g. `args.slice(0, 20_000)` / `input.substring(0, N)` on an
    // identifier that looks like serialized tool-call arguments. Narrow on
    // purpose (limit is honest per review-2: this catches the KNOWN
    // regression shape, not any conceivable mutilation — U*/I1/I2 own that).
    const sliceRe = /\b[\w.]*(input|args|arguments)\w*\s*\.\s*(slice|substring)\s*\(\s*0/i;
    const llmDir = join(CORE_SRC, 'llm');
    const offenders: string[] = [];
    for (const entry of readdirSync(llmDir)) {
      if (!entry.endsWith('Adapter.ts')) continue;
      const src = readFileSync(join(llmDir, entry), 'utf-8');
      if (sliceRe.test(src)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });
});
