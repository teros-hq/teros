// Run: bun test packages/mca-testing/src/quality-gates/output.test.ts
// Run single MCA: bun test packages/mca-testing/src/quality-gates/output.test.ts -t "mca.teros.memory"

import { describe, expect, it } from 'bun:test';
import { discoverMcaDirs, getTools, isReadTool, type ToolDef } from './helpers';

const mcaDirs = discoverMcaDirs();

function readToolsMissingIncludeRaw(tools: ToolDef[]): string[] {
  return tools
    .filter((t) => isReadTool(t.name))
    .filter((t) => !t.inputSchema?.properties?.includeRaw)
    .map((t) => t.name);
}

function toolsWithShortDescription(tools: ToolDef[]): string[] {
  return tools.filter((t) => !t.description || t.description.length < 10).map((t) => t.name);
}

function requiredParamsMissingDescription(tools: ToolDef[]): string[] {
  const violations: string[] = [];
  for (const tool of tools) {
    const required = tool.inputSchema?.required ?? [];
    const props = tool.inputSchema?.properties ?? {};
    for (const param of required) {
      if (!props[param]?.description) {
        violations.push(`${tool.name}.${param}`);
      }
    }
  }
  return violations;
}

describe('MCA Output Quality (Criteria 9-11)', () => {
  for (const mcaDir of mcaDirs) {
    describe(mcaDir, () => {
      // ── Criterion 9: renderer output ────────────────────────────────────

      it.skip('C9 — output adapted to renderer (requires runtime)', () => {});

      // ── Criterion 10: includeRaw on read tools ──────────────────────────

      it('C10 — read tools (get-/list-/search-) accept includeRaw param', () => {
        const tools = getTools(mcaDir);
        const readTools = tools.filter((t) => isReadTool(t.name));
        if (readTools.length === 0) return;
        const missing = readToolsMissingIncludeRaw(tools);
        expect(missing).toEqual([]);
      });

      // ── Criterion 11: descriptions ──────────────────────────────────────

      it('C11 — every tool description >= 10 chars', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const short = toolsWithShortDescription(tools);
        expect(short).toEqual([]);
      });

      it('C11 — required params have descriptions', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const missing = requiredParamsMissingDescription(tools);
        expect(missing).toEqual([]);
      });
    });
  }
});
