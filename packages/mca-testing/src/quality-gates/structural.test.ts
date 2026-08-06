// Run: bun test packages/mca-testing/src/quality-gates/structural.test.ts
// Run single MCA: bun test packages/mca-testing/src/quality-gates/structural.test.ts -t "mca.teros.memory"

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { safeParseMCAManifest } from '../../../shared/src/mca-manifest';
import {
  discoverMcaDirs,
  getTools,
  iconFileSize,
  isPng,
  loadManifest,
  loadPackageJson,
  loadToolsJson,
  MCAS_ROOT,
  resolveIconPath,
} from './helpers';

const mcaDirs = discoverMcaDirs();

describe('MCA Structural Quality (Criteria 1-4)', () => {
  for (const mcaDir of mcaDirs) {
    describe(mcaDir, () => {
      // ── Criterion 1: manifest.json ──────────────────────────────────────

      it('C1 — manifest.json exists and is valid JSON', () => {
        const manifestPath = join(MCAS_ROOT, mcaDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = loadManifest(mcaDir);
        expect(manifest).not.toBeNull();
      });

      it('C1 — manifest.json passes Zod schema validation', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest) return;
        const result = safeParseMCAManifest(manifest);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          expect(result.success).toBe(true);
          console.error(`Schema errors for ${mcaDir}:`, issues);
        }
      });

      it('C1 — manifest.id matches directory name', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest) return;
        expect(manifest.id).toBe(mcaDir);
      });

      // ── Criterion 2: package.json ───────────────────────────────────────

      it('C2 — package.json exists and has @teros/mca-sdk dependency', () => {
        const pkg = loadPackageJson(mcaDir);
        expect(pkg).not.toBeNull();
        if (!pkg) return;
        const hasSdk =
          pkg.dependencies?.['@teros/mca-sdk'] || pkg.devDependencies?.['@teros/mca-sdk'];
        expect(hasSdk).toBeTruthy();
      });

      it('C2 — package.json has "type": "module"', () => {
        const pkg = loadPackageJson(mcaDir);
        if (!pkg) return;
        expect(pkg.type).toBe('module');
      });

      // ── Criterion 3: tools.json ─────────────────────────────────────────

      it('C3 — tools.json exists and has valid structure', () => {
        const tj = loadToolsJson(mcaDir);
        expect(tj).not.toBeNull();
        if (!tj) return;
        expect(tj.mcaId).toBeDefined();
        expect(Array.isArray(tj.tools)).toBe(true);
      });

      it('C3 — tools.json mcaId matches manifest.id', () => {
        const manifest = loadManifest(mcaDir);
        const tj = loadToolsJson(mcaDir);
        if (!manifest || !tj) return;
        expect(tj.mcaId).toBe(manifest.id);
      });

      it('C3 — every tool has complete inputSchema', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const broken = tools.filter(
          (t) => t.inputSchema?.type !== 'object' || typeof t.inputSchema?.properties !== 'object',
        );
        expect(broken.map((t) => t.name)).toEqual([]);
      });

      it('C3 — every tool has a non-empty description', () => {
        const tools = getTools(mcaDir);
        if (tools.length === 0) return;
        const missing = tools.filter((t) => !t.description || t.description.length < 5);
        expect(missing.map((t) => t.name)).toEqual([]);
      });

      // ── Criterion 4: icon ───────────────────────────────────────────────

      it('C4 — icon file exists on disk', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest?.icon) return;
        if (manifest.icon.startsWith('http')) return;
        const iconPath = resolveIconPath(mcaDir, manifest);
        expect(iconPath).not.toBeNull();
      });

      it('C4 — icon is PNG (magic bytes)', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest?.icon || manifest.icon.startsWith('http')) return;
        const iconPath = resolveIconPath(mcaDir, manifest);
        if (!iconPath) return;
        expect(isPng(iconPath)).toBe(true);
      });

      it('C4 — icon file size within 5KB-150KB', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest?.icon || manifest.icon.startsWith('http')) return;
        const iconPath = resolveIconPath(mcaDir, manifest);
        if (!iconPath) return;
        const size = iconFileSize(iconPath);
        expect(size).toBeGreaterThanOrEqual(5 * 1024);
        expect(size).toBeLessThanOrEqual(150 * 1024);
      });
    });
  }
});
