/**
 * Structural invariant (lint-as-test): every dedicated MCA renderer must be wired
 * into `registerMcas.ts`. An unregistered renderer falls to the generic
 * `DefaultToolCallRenderer` at runtime (McaRegistry.get → WrappedDefaultRenderer).
 *
 * This freezes the exact failure mode of incident d1145f92: a BoardRenderer
 * refactor overwrote the Core `register()` block, so 40 sub-renderers silently
 * fell to the default for THREE WEEKS in production. A dropped registration now
 * fails CI instead.
 *
 * Source-based (reads the files, no React Native import → runs under bun), same
 * approach as `toolCallCardAdoption.test.tsx`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MCA_DIR = resolve(__dirname, '../../../../packages/app/src/components/mca');
const RENDERERS_DIR = resolve(MCA_DIR, 'renderers');
const REGISTER_FILE = resolve(MCA_DIR, 'registerMcas.ts');

/**
 * Files that export a `*ToolCallRenderer` but are NOT a real MCA renderer, so
 * they are deliberately absent from `registerMcas.ts`:
 *   - `RendererTemplate.tsx` — scaffold/example for authoring new renderers.
 */
const NOT_AN_MCA_RENDERER = new Set(['RendererTemplate.tsx']);

describe('McaRegistry renderer registration invariant (TER-448)', () => {
  it('every dedicated *ToolCallRenderer file is registered in registerMcas.ts', () => {
    const registerSrc = readFileSync(REGISTER_FILE, 'utf-8');

    const registered = new Set(
      [...registerSrc.matchAll(/ToolCallRenderer:\s*([A-Za-z0-9]+)/g)].map((m) => m[1]),
    );

    // Sanity: the register block wasn't wholesale removed (the d1145f92 shape).
    const registerCount = [...registerSrc.matchAll(/McaRegistry\.register\(/g)].length;
    expect(registerCount).toBeGreaterThan(25);

    const unregistered: string[] = [];
    for (const file of readdirSync(RENDERERS_DIR)) {
      if (!file.endsWith('.tsx') || NOT_AN_MCA_RENDERER.has(file)) continue;
      const src = readFileSync(resolve(RENDERERS_DIR, file), 'utf-8');
      const exported = src.match(
        /export\s+(?:const|function|class)\s+([A-Za-z0-9]+ToolCallRenderer)\b/,
      )?.[1];
      if (exported && !registered.has(exported)) {
        unregistered.push(`${file}:${exported}`);
      }
    }

    expect(unregistered).toEqual([]);
  });
});
