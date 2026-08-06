// Run: bun test packages/mca-testing/src/quality-gates/code.test.ts
// Run single MCA: bun test packages/mca-testing/src/quality-gates/code.test.ts -t "mca.teros.memory"

import { describe, expect, it } from 'bun:test';
import {
  discoverMcaDirs,
  getTools,
  isHealthCheckTool,
  loadToolsJson,
  readAllSourceFiles,
  readEntrySource,
} from './helpers';

const mcaDirs = discoverMcaDirs();

const FORBIDDEN_IMPORT = /from\s+['"]@modelcontextprotocol\/sdk/;
const RELATIVE_SDK_IMPORT = /from\s+['"]\.\..*mca-sdk/;
const MODULE_SCOPE_SECRETS = /^(?!\s)(.*(?:getSystemSecrets|getUserSecrets)\s*\()/;

describe('MCA Code Quality (Criteria 5-7)', () => {
  for (const mcaDir of mcaDirs) {
    describe(mcaDir, () => {
      // ── Criterion 5: SDK imports ────────────────────────────────────────

      it('C5 — no @modelcontextprotocol/sdk imports in source', () => {
        const sources = readAllSourceFiles(mcaDir);
        if (sources.size === 0) return;
        const violations: string[] = [];
        for (const [path, content] of sources) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (FORBIDDEN_IMPORT.test(lines[i])) {
              violations.push(`${path}:${i + 1}`);
            }
          }
        }
        expect(violations).toEqual([]);
      });

      it('C5 — no relative SDK path imports', () => {
        const sources = readAllSourceFiles(mcaDir);
        if (sources.size === 0) return;
        const violations: string[] = [];
        for (const [path, content] of sources) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (RELATIVE_SDK_IMPORT.test(lines[i])) {
              violations.push(`${path}:${i + 1}`);
            }
          }
        }
        expect(violations).toEqual([]);
      });

      // ── Criterion 6: lazy secrets ───────────────────────────────────────

      it('C6 — no module-scope secret loading in entrypoint', () => {
        const src = readEntrySource(mcaDir);
        if (!src) return;

        const lines = src.split('\n');
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (MODULE_SCOPE_SECRETS.test(line)) {
            violations.push(`line ${i + 1}: ${line.trim()}`);
          }
        }
        expect(violations).toEqual([]);
      });

      // ── Criterion 7: health-check tool ──────────────────────────────────

      it('C7 — health-check tool exists in tools.json', () => {
        const tj = loadToolsJson(mcaDir);
        if (!tj) return;
        const tools = getTools(mcaDir);
        const hasHealthCheck = tools.some((t) => isHealthCheckTool(t.name));
        expect(hasHealthCheck).toBe(true);
      });

      it('C7 — health-check tool has empty/optional-only params', () => {
        const tools = getTools(mcaDir);
        const hcTool = tools.find((t) => isHealthCheckTool(t.name));
        if (!hcTool) return;

        const props = hcTool.inputSchema?.properties ?? {};
        const required = hcTool.inputSchema?.required ?? [];
        expect(required).toEqual([]);
        if (Object.keys(props).length > 0) {
          expect(required.length).toBe(0);
        }
      });

      // ── Criterion 8: no startup crashes ─────────────────────────────────
      // Runtime validation: covered by smoke tests (health() returns 'ready').
      // Static approximation: verify entrypoint has no unguarded top-level throw.

      it('C8 — entrypoint has no unguarded top-level throw', () => {
        const src = readEntrySource(mcaDir);
        if (!src) return;

        const lines = src.split('\n');
        const violations: string[] = [];
        let insideFunction = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\b(?:function|async\s+function|=>)\b/.test(line) || /\{/.test(line)) {
            insideFunction += (line.match(/\{/g) || []).length;
          }
          if (/\}/.test(line)) {
            insideFunction -= (line.match(/\}/g) || []).length;
          }
          if (insideFunction <= 0 && /^\s*throw\s/.test(line)) {
            violations.push(`line ${i + 1}: unguarded top-level throw`);
          }
        }
        expect(violations).toEqual([]);
      });
    });
  }
});
