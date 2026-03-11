#!/usr/bin/env bun
/**
 * Validate MCA Manifests
 *
 * Validates all MCA manifest.json files against the schema.
 *
 * Usage:
 *   bun scripts/validate-manifests.ts                    # All MCAs
 *   bun scripts/validate-manifests.ts mca.google.gmail   # Specific MCA
 *   bun scripts/validate-manifests.ts --help             # Help
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { validateMCAManifest } from '../packages/shared/src/mca-manifest';

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
 * Validate a single MCA manifest
 */
function validateMca(mcaId: string): { mcaId: string; valid: boolean; errors: string[] } {
  const manifestPath = join(MCAS_PATH, mcaId, 'manifest.json');

  if (!existsSync(manifestPath)) {
    return { mcaId, valid: false, errors: ['manifest.json not found'] };
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const data = JSON.parse(content);
    const result = validateMCAManifest(data);
    return { mcaId, ...result };
  } catch (error: any) {
    if (error.name === 'SyntaxError') {
      return { mcaId, valid: false, errors: [`Invalid JSON: ${error.message}`] };
    }
    return { mcaId, valid: false, errors: [error.message] };
  }
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
  bun scripts/validate-manifests.ts --help             # This help

Validates manifest.json files against the MCA manifest schema.
`);
    process.exit(0);
  }

  console.log('🔍 MCA Manifest Validator\n');

  // Determine which MCAs to validate
  let mcaIds: string[];

  if (args.length > 0) {
    mcaIds = args;
  } else {
    mcaIds = discoverMcas();
  }

  console.log(`Found ${mcaIds.length} MCA(s) to validate\n`);

  // Validate each MCA
  const results: { mcaId: string; valid: boolean; errors: string[] }[] = [];

  for (const mcaId of mcaIds) {
    const result = validateMca(mcaId);
    results.push(result);

    if (result.valid) {
      console.log(`✅ ${mcaId}`);
    } else {
      console.log(`❌ ${mcaId}`);
      result.errors.forEach((err) => console.log(`   - ${err}`));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  const valid = results.filter((r) => r.valid);
  const invalid = results.filter((r) => !r.valid);

  console.log(`\nSummary: ${valid.length} valid, ${invalid.length} invalid`);

  if (invalid.length > 0) {
    console.log('\nInvalid manifests:');
    invalid.forEach((r) => {
      console.log(`  - ${r.mcaId}`);
      r.errors.forEach((err) => console.log(`      ${err}`));
    });
    process.exit(1);
  }

  console.log('\n✨ All manifests are valid!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
