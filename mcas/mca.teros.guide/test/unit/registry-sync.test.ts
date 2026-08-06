/**
 * Invariante registry-sync de mca.teros.guide (patrón TER-498/TER-503).
 *
 * El LLM lee tools.json, NO la fuente TS (MCA-RUNBOOK criterio 3). Este test
 * MUERDE: si tools.json se desincroniza del código (una tool ausente, una
 * description editada solo en un lado, el enum de topics desfasado), falla.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOOLS } from '../../src/tools/registry';

const ROOT = resolve(import.meta.dir, '../..');
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, 'utf8'));

describe('registry-sync — tools.json ↔ TOOLS', () => {
  it('hay 4 tools definidas', () => {
    expect(TOOLS.length).toBe(4);
    expect(toolsJson.tools.length).toBe(4);
  });

  it('mcaId correcto', () => {
    expect(toolsJson.mcaId).toBe('mca.teros.guide');
  });

  it('names 1:1', () => {
    const srcNames = TOOLS.map((t) => t.name).sort();
    // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort();
    expect(srcNames).toEqual(jsonNames);
    expect(srcNames).toContain('-health-check');
    expect(srcNames).toContain('list-guide-topics');
    expect(srcNames).toContain('search-guide');
    expect(srcNames).toContain('get-guide-section');
  });

  it.each(TOOLS.map((t) => [t.name] as const))(
    '%s: description e inputSchema EXACTOS',
    (name) => {
      const src = TOOLS.find((t) => t.name === name);
      // biome-ignore lint/suspicious/noExplicitAny: shape del tools.json
      const json = toolsJson.tools.find((t: any) => t.name === name);
      expect(json, `${name} ausente de tools.json`).toBeDefined();
      expect(json.description).toBe(src?.description);
      expect(json.inputSchema).toEqual(src?.inputSchema);
    },
  );
});
