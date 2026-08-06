#!/usr/bin/env bun
/**
 * Validate MCA Manifests
 *
 * Validates all MCA manifest.json files against the schema AND validates
 * the icon file referenced in each manifest (see Section 10 of

 *
 * Usage:
 *   bun scripts/validate-manifests.ts                    # All MCAs
 *   bun scripts/validate-manifests.ts mca.google.gmail   # Specific MCA
 *   bun scripts/validate-manifests.ts --skip-icons       # Skip icon validation
 *   bun scripts/validate-manifests.ts --help             # Help
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { validateMCAManifest } from '../packages/shared/src/mca-manifest';
import { validateMcaIcon } from './validate-icons';

const MCAS_PATH = join(import.meta.dir, '../mcas');

/**
 * Discover all MCAs in the mcas directory
 */
function discoverMcas(): string[] {
  const entries = readdirSync(MCAS_PATH, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mca.'))
    .map((entry) => entry.name);
}

/**
 * Validate a single MCA — manifest schema + icon file
 */
function validateMca(
  mcaId: string,
  options: { skipIcons?: boolean },
): { mcaId: string; valid: boolean; errors: string[]; warnings: string[] } {
  const manifestPath = join(MCAS_PATH, mcaId, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return { mcaId, valid: false, errors: ['manifest.json not found'], warnings: [] };
  }

  let data: any;
  let manifestErrors: string[] = [];
  let manifestWarnings: string[] = [];

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    data = JSON.parse(content);
    const result = validateMCAManifest(data);

    if (!result.valid) {
      manifestErrors = result.errors.map((e) => `[manifest] ${e.path}: ${e.message}`);
    }
    manifestWarnings = result.warnings.map((w) => `[manifest] ${w.path}: ${w.message}`);
  } catch (error: any) {
    const msg =
      error.name === 'SyntaxError' ? `Invalid JSON: ${error.message}` : error.message;
    return { mcaId, valid: false, errors: [`[manifest] ${msg}`], warnings: [] };
  }

  // ── Icon validation ───────────────────────────────────────────────────────

  const iconErrors: string[] = [];
  const iconWarnings: string[] = [];

  if (!options.skipIcons) {
    const iconField = typeof data?.icon === 'string' ? data.icon : null;

    if (!iconField) {
      // manifest schema already catches missing icon; don't double-report
    } else {
      const iconResult = validateMcaIcon(mcaId, iconField);
      iconErrors.push(...iconResult.errors.map((e) => `[icon] ${e}`));
      iconWarnings.push(...iconResult.warnings.map((w) => `[icon] ${w}`));
    }
  }

  const allErrors = [...manifestErrors, ...iconErrors];
  const allWarnings = [...manifestWarnings, ...iconWarnings];

  return {
    mcaId,
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}

/**
 * Main
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Validate MCA Manifests

Usage:
  bun scripts/validate-manifests.ts                    # All MCAs
  bun scripts/validate-manifests.ts mca.google.gmail   # Specific MCA
  bun scripts/validate-manifests.ts --skip-icons       # Skip icon validation
  bun scripts/validate-manifests.ts --help             # This help

Validates:
  1. manifest.json schema (id, version, auth, runtime, etc.)
  2. Icon file: existence, PNG format, square, min 256×256, size limits,
     and placeholder detection (solid-color / near-uniform fills).


`);
    process.exit(0);
  }

  const skipIcons = args.includes('--skip-icons');
  const mcaArgs = args.filter((a) => !a.startsWith('--'));

  console.log('🔍 MCA Manifest Validator\n');

  if (skipIcons) {
    console.log('  ⚠️  Icon validation skipped (--skip-icons)\n');
  }

  // Determine which MCAs to validate
  const mcaIds = mcaArgs.length > 0 ? mcaArgs : discoverMcas();

  console.log(`Found ${mcaIds.length} MCA(s) to validate\n`);

  // Validate each MCA
  const results: { mcaId: string; valid: boolean; errors: string[]; warnings: string[] }[] = [];

  for (const mcaId of mcaIds) {
    const result = validateMca(mcaId, { skipIcons });
    results.push(result);

    if (result.valid) {
      const hasWarnings = result.warnings.length > 0;
      console.log(`${hasWarnings ? '⚠️ ' : '✅'} ${mcaId}`);
      result.warnings.forEach((w) => console.log(`   ⚠️  ${w}`));
    } else {
      console.log(`❌ ${mcaId}`);
      result.errors.forEach((err) => console.log(`   - ${err}`));
      result.warnings.forEach((w) => console.log(`   ⚠️  ${w}`));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  const valid = results.filter((r) => r.valid);
  const invalid = results.filter((r) => !r.valid);

  console.log(`\nSummary: ${valid.length} valid, ${invalid.length} invalid`);

  if (invalid.length > 0) {
    console.log('\nInvalid MCAs:');
    invalid.forEach((r) => {
      console.log(`  - ${r.mcaId}`);
      r.errors.forEach((err) => console.log(`      ${err}`));
    });
    process.exit(1);
  }

  console.log('\n✨ All manifests and icons are valid!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
