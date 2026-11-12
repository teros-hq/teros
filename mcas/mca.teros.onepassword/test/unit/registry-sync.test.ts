/**
 * Registry-sync invariant for mca.teros.onepassword (pattern TER-498, same as
 * mca.teros.holded). The LLM reads tools.json, NOT the TS source — so the
 * tools.json must stay 1:1 with what src/index.ts registers, and each tool's
 * description + inputSchema must match its source config EXACTLY.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const indexSource = readFileSync(`${ROOT}/src/index.ts`, 'utf8');
const toolsJson = JSON.parse(readFileSync(`${ROOT}/tools.json`, 'utf8'));

const registered = [...indexSource.matchAll(/server\.tool\('([^']+)',\s*([A-Za-z0-9_]+)\)/g)].map(
  (m) => ({ name: m[1], symbol: m[2] }),
);

const jsonByName = new Map<string, { description: string; inputSchema: unknown }>(
  // biome-ignore lint/suspicious/noExplicitAny: tools.json shape
  toolsJson.tools.map((t: any) => [t.name, t]),
);

const mod = await import('../../src/tools');

describe('registry-sync — tools.json ↔ src', () => {
  it('registers the 4 tools with symbols', () => {
    expect(registered.length).toBe(4);
    expect(registered.map((r) => r.name).sort()).toEqual(
      ['-health-check', 'get-item-fields', 'list-items', 'list-vaults'].sort(),
    );
  });

  it('names 1:1 between server.tool() and tools.json', () => {
    const srcNames = [...indexSource.matchAll(/server\.tool\('([^']+)'/g)].map((m) => m[1]).sort();
    // biome-ignore lint/suspicious/noExplicitAny: tools.json shape
    const jsonNames = toolsJson.tools.map((t: any) => t.name).sort();
    expect(srcNames).toEqual(jsonNames);
  });

  it.each(registered.map((r) => [r.name, r.symbol] as const))(
    '%s: description and parameters EXACT',
    (name, symbol) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic module access
      const config = (mod as any)[symbol];
      expect(config, `${symbol} is not exported from src/tools`).toBeDefined();
      const json = jsonByName.get(name);
      expect(json, `${name} missing from tools.json`).toBeDefined();
      expect(json?.description).toBe(config.description);
      expect(json?.inputSchema).toEqual(config.parameters);
    },
  );
});
