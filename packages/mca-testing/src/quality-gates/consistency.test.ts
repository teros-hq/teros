// Run: bun test packages/mca-testing/src/quality-gates/consistency.test.ts
// Run single MCA: bun test packages/mca-testing/src/quality-gates/consistency.test.ts -t "mca.teros.memory"

import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverMcaDirs,
  getTools,
  loadManifest,
  loadPackageJson,
  loadToolsJson,
  MCAS_ROOT,
  readEntrySource,
} from './helpers';

const mcaDirs = discoverMcaDirs();

const SERVER_TOOL_CALL = /server\.tool\s*\(/g;

describe('MCA Cross-File Consistency', () => {
  for (const mcaDir of mcaDirs) {
    describe(mcaDir, () => {
      it('entrypoint file exists on disk', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest?.entrypoint) return;
        const entrypoint = manifest.entrypoint.replace(/^\.\//, '');
        const fullPath = join(MCAS_ROOT, mcaDir, entrypoint);
        expect(existsSync(fullPath)).toBe(true);
      });

      it('manifest.id matches package.json name', () => {
        const manifest = loadManifest(mcaDir);
        const pkg = loadPackageJson(mcaDir);
        if (!manifest || !pkg) return;
        expect(pkg.name).toBe(manifest.id);
      });

      it('tools.json tool count is consistent with source registrations', () => {
        const tools = getTools(mcaDir);
        const src = readEntrySource(mcaDir);
        if (tools.length === 0 || !src) return;

        const matches = src.match(SERVER_TOOL_CALL);
        const sourceCount = matches?.length ?? 0;
        if (sourceCount === 0) return;

        const diff = Math.abs(tools.length - sourceCount);
        if (diff > 2) {
          console.warn(
            `[WARN] ${mcaDir}: tools.json has ${tools.length} tools but source has ${sourceCount} server.tool() calls (diff=${diff})`,
          );
        }
        expect(diff).toBeLessThanOrEqual(3);
      });

      it('no @modelcontextprotocol/sdk in package.json dependencies', () => {
        const pkg = loadPackageJson(mcaDir);
        if (!pkg) return;
        const inDeps = pkg.dependencies?.['@modelcontextprotocol/sdk'];
        const inDev = pkg.devDependencies?.['@modelcontextprotocol/sdk'];
        if (inDeps || inDev) {
          expect(inDeps ?? inDev).toBeUndefined();
        }
      });

      it('static/ directory exists when icon is a filename', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest?.icon) return;
        if (manifest.icon.startsWith('http')) return;
        const staticDir = join(MCAS_ROOT, mcaDir, 'static');
        expect(existsSync(staticDir)).toBe(true);
      });

      it('auth MCAs use per-app container mode', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest) return;
        const auth = manifest.layers?.auth;
        if (!auth || auth === false || auth.type === 'none') return;
        expect(manifest.runtime?.containerMode).toBe('per-app');
      });

      it('disabled MCAs are flagged (informational)', () => {
        const manifest = loadManifest(mcaDir);
        if (!manifest) return;
        if (manifest.availability?.enabled === false) {
          console.warn(`[INFO] ${mcaDir} is disabled (availability.enabled = false)`);
        }
        expect(true).toBe(true);
      });
    });
  }
});
