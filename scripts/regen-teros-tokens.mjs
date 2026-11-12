#!/usr/bin/env node
// Regenerates the DS token bridge consumed by the app:
//   packages/app/src/components/ui/teros-tokens.ts
//
// The single source of truth is the design system's tokens.js. This wrapper
// calls the DS generator directly so the app copy can never drift from it:
//
//     node scripts/regen-teros-tokens.mjs
//
// The generator lives in the DS repo — default /workspace/teros-ui/design-system
// (override with TEROS_DS_PATH). Do not edit the emitted .ts by hand; if the
// bridge is missing something, extend the DS generator
// (design-system/scripts/export-tokens-ts.mjs), not the output.
//
// NOTE: NODE_OPTIONS is cleared because dd-trace is not installed where the
// DS volume lives; the generator does not need it.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DS = process.env.TEROS_DS_PATH || '/workspace/teros-ui/design-system';
const GEN = join(DS, 'scripts', 'export-tokens-ts.mjs');
const OUT = resolve(ROOT, 'packages/app/src/components/ui/teros-tokens.ts');

try {
  execFileSync('node', [GEN, OUT], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
} catch {
  console.error('[regen-teros-tokens] generator failed. Is the DS repo at: ' + DS + ' ?');
  console.error('  expected generator at: ' + GEN);
  console.error('  (or set TEROS_DS_PATH to the design-system folder)');
  process.exit(1);
}
