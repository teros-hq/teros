/**
 * Architectural invariant (lint-as-test): mca.teros.core renderer coverage.
 *
 * CLAUDE.md mandates 100% renderer coverage — every tool has a dedicated
 * sub-renderer; a FallbackRenderer hit is a bug. This guards the tool↔renderer
 * sync as tools are added/removed (here: list-agent-cores was removed).
 *
 * Reads source instead of importing the module (the tamagui import chain is not
 * loadable under bun — same approach as toolCallCardAdoption.test.tsx).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const rendererSrc = readFileSync(
  join(
    import.meta.dir,
    '../../../../packages/app/src/components/mca/renderers/TerosCoreRenderer.tsx',
  ),
  'utf8',
);
const toolsJson = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../mcas/mca.teros.core/tools.json'), 'utf8'),
) as { tools: Array<{ name: string }> };

// Keys registered in the `const RENDERERS = { ... }` map.
const block = rendererSrc.slice(
  rendererSrc.indexOf('const RENDERERS'),
  rendererSrc.indexOf('function TerosCoreRendererBase'),
);
const registered = new Set([...block.matchAll(/'([a-z0-9-]+)':/g)].map((m) => m[1]));

// '-health-check' is rendered by the canonical health renderer, not this map.
const toolNames = toolsJson.tools.map((t) => t.name).filter((n) => n !== '-health-check');

describe('mca.teros.core renderer coverage (FallbackRenderer = bug)', () => {
  it('every tool has a dedicated sub-renderer', () => {
    const missing = toolNames.filter((n) => !registered.has(n));
    expect(missing).toEqual([]);
  });

  it('the removed list-agent-cores tool has neither entry nor renderer', () => {
    expect(toolNames).not.toContain('list-agent-cores');
    expect(registered.has('list-agent-cores')).toBe(false);
  });
});
