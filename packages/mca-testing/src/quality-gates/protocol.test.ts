// Run: bun test packages/mca-testing/src/quality-gates/protocol.test.ts
// Run single MCA: bun test packages/mca-testing/src/quality-gates/protocol.test.ts -t "mca.teros.memory"

import { describe, expect, it } from 'bun:test';
import {
  discoverMcaDirs,
  getTools,
  isDestructiveTool,
  isHealthCheckTool,
  isListTool,
  isReadTool,
  readAllSourceFiles,
  type ToolDef,
} from './helpers';

const mcaDirs = discoverMcaDirs();

const VALID_STABILITY = new Set(['experimental', 'stable', 'deprecated']);
const HINT_FIELDS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
  'irreversible',
  'alwaysAsk',
];

function listToolsMissingParam(tools: ToolDef[], param: string): string[] {
  return tools
    .filter((t) => isListTool(t.name))
    .filter((t) => !t.inputSchema?.properties?.[param])
    .map((t) => t.name);
}

function toolsMissingAnnotations(tools: ToolDef[]): string[] {
  return tools
    .filter((t) => !t.annotations?.version || !t.annotations?.stability)
    .map((t) => t.name);
}

function toolsWithInvalidHintTypes(tools: ToolDef[]): string[] {
  const violations: string[] = [];
  for (const tool of tools) {
    if (!tool.annotations) continue;
    for (const field of HINT_FIELDS) {
      const val = tool.annotations[field];
      if (val !== undefined && typeof val !== 'boolean') {
        violations.push(`${tool.name}.${field} (got ${typeof val})`);
      }
    }
  }
  return violations;
}

function readToolsMissingReadOnlyHint(tools: ToolDef[]): string[] {
  return tools
    .filter((t) => isReadTool(t.name) && t.annotations)
    .filter((t) => t.annotations!.readOnlyHint !== true)
    .map((t) => t.name);
}

function destructiveToolsMissingHint(tools: ToolDef[]): string[] {
  // destructiveHint is optional per-MCA curation: only check consistency
  // when it IS declared (annotations are now universal — readOnlyHint was
  // baked into every tool — so "has annotations" no longer means "curated").
  return tools
    .filter((t) => isDestructiveTool(t.name) && t.annotations?.destructiveHint !== undefined)
    .filter((t) => t.annotations!.destructiveHint !== true)
    .map((t) => t.name);
}

function publicToolsMissingReadOnlyHint(tools: ToolDef[]): string[] {
  // The explicit-annotations contract (2026-07-04, heuristic removed):
  // every public tool MUST declare readOnlyHint — the permission gate
  // treats missing as mutation, so an omission silently disables the
  // read-only auto-allow for that tool.
  return tools
    .filter((t) => !t.name.startsWith('-'))
    .filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean')
    .map((t) => t.name);
}

function readOnlyToolsClaimingDestructiveName(tools: ToolDef[]): string[] {
  // Contradiction guard: a delete-/remove-/purge-named tool marked
  // readOnlyHint: true is almost certainly a curation mistake.
  return tools
    .filter((t) => isDestructiveTool(t.name) && t.annotations?.readOnlyHint === true)
    .map((t) => t.name);
}

describe('MCA Protocol Compliance (Criteria 15-17)', () => {
  for (const mcaDir of mcaDirs) {
    describe(mcaDir, () => {
      // ── Criterion 15: structuredContent ─────────────────────────────────
      // structuredContent is optional per protocol. This static check verifies
      // that MCAs which DO use it reference it in source. MCAs that don't use
      // it at all pass trivially (adoption is tracked separately).
      // Full runtime shape validation belongs in smoke tests.

      it('C15 — structuredContent adoption tracked', () => {
        const sources = readAllSourceFiles(mcaDir);
        if (sources.size === 0) return;

        let usesStructuredContent = false;
        for (const [, content] of sources) {
          if (/structuredContent/.test(content)) {
            usesStructuredContent = true;
            break;
          }
        }

        if (!usesStructuredContent) {
          // Not adopted yet — track but don't fail
          return;
        }

        // If adopted, verify it appears in tool handler files (not just types)
        const handlerFiles = [...sources.entries()].filter(
          ([p]) => !p.includes('.d.ts') && !p.includes('types'),
        );
        const inHandlers = handlerFiles.some(([, c]) => /structuredContent/.test(c));
        expect(inHandlers).toBe(true);
      });

      // ── Criterion 16: pagination ────────────────────────────────────────

      it('C16 — list-* tools have limit parameter', () => {
        const tools = getTools(mcaDir);
        const listTools = tools.filter((t) => isListTool(t.name));
        if (listTools.length === 0) return;
        const missing = listToolsMissingParam(tools, 'limit');
        expect(missing).toEqual([]);
      });

      it('C16 — list-* tools have cursor parameter', () => {
        const tools = getTools(mcaDir);
        const listTools = tools.filter((t) => isListTool(t.name));
        if (listTools.length === 0) return;
        const missing = listToolsMissingParam(tools, 'cursor');
        expect(missing).toEqual([]);
      });

      // ── Criterion 17: annotations ───────────────────────────────────────

      it('C17 — tools have annotations (version + stability)', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const missing = toolsMissingAnnotations(tools);
        expect(missing).toEqual([]);
      });

      it('C17 — annotation hint fields are booleans', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const violations = toolsWithInvalidHintTypes(tools);
        expect(violations).toEqual([]);
      });

      it('C17 — annotated read tools have readOnlyHint: true', () => {
        const tools = getTools(mcaDir);
        const annotatedReadTools = tools.filter((t) => isReadTool(t.name) && t.annotations);
        if (annotatedReadTools.length === 0) return;
        const missing = readToolsMissingReadOnlyHint(tools);
        expect(missing).toEqual([]);
      });

      it('C17 — declared destructiveHint is consistent with destructive names', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const missing = destructiveToolsMissingHint(tools);
        expect(missing).toEqual([]);
      });

      it('C17 — every public tool declares readOnlyHint (explicit contract)', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const missing = publicToolsMissingReadOnlyHint(tools);
        expect(missing).toEqual([]);
      });

      it('C17 — destructive-named tools are not marked readOnlyHint: true', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const contradictions = readOnlyToolsClaimingDestructiveName(tools);
        expect(contradictions).toEqual([]);
      });

      // ── Criterion 18: resilience ────────────────────────────────────────

      it.skip('C18 — timeouts + retries (requires runtime)', () => {});
    });
  }
});
