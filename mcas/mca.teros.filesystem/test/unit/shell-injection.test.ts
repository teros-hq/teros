/**
 * Shell injection regression tests.
 *
 * The previous implementation used `exec(\`grep -r -l -E "${pattern}" "${searchPath}"\`)`
 * which interpolated user-controlled strings directly into the shell. The current
 * implementation uses `execa(rgPath, args[])` which passes arguments without spawning
 * a shell, so even the nastiest regex characters stay literal.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRipgrep } from '../../src/lib/ripgrep';

const BASE = join(tmpdir(), `fs-v2-injection-${Date.now()}`);
const SENTINEL = join(BASE, 'SENTINEL_MUST_NOT_BE_CREATED.txt');

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
  writeFileSync(join(BASE, 'a.txt'), 'alpha foo beta\n');
  writeFileSync(join(BASE, 'b.txt'), 'gamma delta\n');
});

afterEach(() => {
  if (existsSync(BASE)) rmSync(BASE, { recursive: true, force: true });
  if (existsSync(SENTINEL)) rmSync(SENTINEL);
});

describe('ripgrep wrapper — shell injection safety', () => {
  it('treats shell metacharacters in the pattern as literal regex', async () => {
    const pattern = `foo" -exec touch ${SENTINEL} ; --`;
    const result = await runRipgrep({
      pattern,
      path: BASE,
      respectGitignore: false,
    });
    // Pattern should not match anything (literal regex), but importantly the
    // side-effect command must NOT have run.
    expect(existsSync(SENTINEL)).toBe(false);
    expect(result.totalMatches).toBe(0);
  });

  it('pattern with pipe and backticks does not execute them', async () => {
    const pattern = `$(touch ${SENTINEL}) | ls`;
    await runRipgrep({ pattern, path: BASE, respectGitignore: false }).catch(() => {
      /* rg may error on invalid regex — that's fine; we only care about side effects */
    });
    expect(existsSync(SENTINEL)).toBe(false);
  });

  it('normal regex still works', async () => {
    const result = await runRipgrep({
      pattern: 'foo',
      path: BASE,
      contextBefore: 0,
      contextAfter: 0,
      respectGitignore: false,
    });
    expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]?.file).toContain('a.txt');
  });

  it('context lines are populated', async () => {
    writeFileSync(
      join(BASE, 'ctx.txt'),
      ['line1', 'line2', 'match-here', 'line4', 'line5'].join('\n'),
    );
    const result = await runRipgrep({
      pattern: 'match-here',
      path: BASE,
      contextBefore: 2,
      contextAfter: 2,
      respectGitignore: false,
    });
    const match = result.matches.find((m) => m.file.endsWith('ctx.txt'));
    expect(match).toBeDefined();
    expect(match!.contextBefore.length).toBe(2);
    expect(match!.contextAfter.length).toBe(2);
    expect(match!.contextBefore[0]?.text).toBe('line1');
    expect(match!.contextAfter[1]?.text).toBe('line5');
  });
});
