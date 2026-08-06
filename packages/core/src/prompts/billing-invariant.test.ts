/**
 * Invariant (decisión #12, FASE 0.5c): the model's prompt must NEVER carry
 * billing / usage / remaining-hours information. Exposing the remaining time
 * would alter the model's behavior. Today nothing under src/prompts/ references
 * billing; this lint-as-test fails the build if anyone wires it in.
 *
 * If a legitimate reason ever requires one of these tokens here, this test must
 * be updated deliberately — that is the point: make the leak impossible by
 * accident.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('prompts — billing must not leak into the model context (FASE 0.5c)', () => {
  const PROMPTS_DIR = import.meta.dir;
  const FORBIDDEN: Array<{ re: RegExp; label: string }> = [
    { re: /agentHoursUsed/, label: 'agentHoursUsed' },
    { re: /agentHoursLimit/, label: 'agentHoursLimit' },
    { re: /hoursRemaining/i, label: 'hoursRemaining' },
    { re: /hoursLimit/i, label: 'hoursLimit' },
    { re: /HoursExhausted/, label: 'HoursExhausted' },
    { re: /\bbilling\b/i, label: 'billing' },
  ];

  const files = readdirSync(PROMPTS_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );

  it('has prompt source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} carries no billing/usage identifiers`, () => {
      const src = readFileSync(join(PROMPTS_DIR, file), 'utf8');
      for (const { re, label } of FORBIDDEN) {
        if (re.test(src)) {
          throw new Error(
            `${file} references "${label}" — billing/usage info must not reach the model prompt (decisión #12).`,
          );
        }
      }
    });
  }
});
