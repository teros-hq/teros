#!/usr/bin/env tsx

/**
 * Validate MCAs Script
 *
 * Validates all MCA manifest.json files against the schema.
 * Exits with code 1 if any MCA is invalid.
 *
 * Usage:
 *   npx tsx src/scripts/validate-mcas.ts [--strict] [--json] [mca-id...]
 *
 * Options:
 *   --strict    Treat warnings as errors
 *   --json      Output results as JSON
 *   mca-id...   Validate specific MCAs only (e.g., mca.google.gmail)
 *
 * Examples:
 *   npx tsx src/scripts/validate-mcas.ts
 *   npx tsx src/scripts/validate-mcas.ts --strict
 *   npx tsx src/scripts/validate-mcas.ts mca.google.gmail mca.teros.bash
 */

import {
  formatValidationResult,
  type MCAValidationResult,
  validateMCAManifest,
} from '@teros/shared';
import { access, readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to MCAs directory (relative to teros-v2 root)
const MCAS_DIR = join(__dirname, '../../../../mcas');

interface ValidationSummary {
  total: number;
  valid: number;
  invalid: number;
  warnings: number;
  results: Record<string, MCAValidationResult>;
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a single MCA
 */
async function validateMca(
  mcaDir: string,
): Promise<{ mcaId: string; result: MCAValidationResult }> {
  const manifestPath = join(MCAS_DIR, mcaDir, 'manifest.json');

  // Check if manifest exists
  if (!(await fileExists(manifestPath))) {
    return {
      mcaId: mcaDir,
      result: {
        valid: false,
        errors: [{ path: 'manifest.json', message: 'File not found', code: 'missing_file' }],
        warnings: [],
      },
    };
  }

  try {
    const content = await readFile(manifestPath, 'utf-8');
    let data: unknown;

    try {
      data = JSON.parse(content);
    } catch (parseError) {
      return {
        mcaId: mcaDir,
        result: {
          valid: false,
          errors: [
            {
              path: 'manifest.json',
              message: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Parse error'}`,
              code: 'invalid_json',
            },
          ],
          warnings: [],
        },
      };
    }

    const result = validateMCAManifest(data);
    const mcaId = result.manifest?.id || mcaDir;

    // Additional file checks
    if (result.valid && result.manifest) {
      // Check entrypoint exists
      const entrypointPath = join(MCAS_DIR, mcaDir, result.manifest.entrypoint);
      if (!(await fileExists(entrypointPath))) {
        result.warnings.push({
          path: 'entrypoint',
          message: `File not found: ${result.manifest.entrypoint}`,
        });
      }

      // Check tools.json exists for MCAs with tools layer
      if (result.manifest.layers.tools) {
        const toolsPath = join(MCAS_DIR, mcaDir, 'tools.json');
        if (!(await fileExists(toolsPath))) {
          result.warnings.push({
            path: 'tools.json',
            message: 'MCA has tools: true but tools.json not found. Run generate-mca-tools.ts',
          });
        }
      }

      // Check icon exists
      const iconPath = join(MCAS_DIR, mcaDir, result.manifest.icon);
      if (!result.manifest.icon.startsWith('http') && !(await fileExists(iconPath))) {
        result.warnings.push({
          path: 'icon',
          message: `Icon file not found: ${result.manifest.icon}`,
        });
      }
    }

    return { mcaId, result };
  } catch (error) {
    return {
      mcaId: mcaDir,
      result: {
        valid: false,
        errors: [
          {
            path: 'manifest.json',
            message: `Read error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            code: 'read_error',
          },
        ],
        warnings: [],
      },
    };
  }
}

/**
 * Validate all MCAs
 */
async function validateAllMcas(specificMcas?: string[]): Promise<ValidationSummary> {
  const summary: ValidationSummary = {
    total: 0,
    valid: 0,
    invalid: 0,
    warnings: 0,
    results: {},
  };

  let mcaDirs: string[];

  if (specificMcas && specificMcas.length > 0) {
    // Validate specific MCAs
    mcaDirs = specificMcas;
  } else {
    // Get all MCA directories
    const entries = await readdir(MCAS_DIR, { withFileTypes: true });
    mcaDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mca.'))
      .map((entry) => entry.name);
  }

  for (const mcaDir of mcaDirs) {
    const { mcaId, result } = await validateMca(mcaDir);
    summary.results[mcaId] = result;
    summary.total++;

    if (result.valid) {
      summary.valid++;
      if (result.warnings.length > 0) {
        summary.warnings += result.warnings.length;
      }
    } else {
      summary.invalid++;
    }
  }

  return summary;
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const jsonOutput = args.includes('--json');
  const specificMcas = args.filter((arg) => !arg.startsWith('--'));

  if (!jsonOutput) {
    console.log('🔍 Validating MCA manifests...\n');
    console.log(`MCAs directory: ${MCAS_DIR}\n`);
    if (strict) {
      console.log('⚠️  Strict mode: warnings will be treated as errors\n');
    }
  }

  const summary = await validateAllMcas(specificMcas.length > 0 ? specificMcas : undefined);

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    // Print results
    for (const [mcaId, result] of Object.entries(summary.results)) {
      console.log(formatValidationResult(mcaId, result));
    }

    // Print summary
    console.log('\n' + '─'.repeat(60));
    console.log('📊 Summary:');
    console.log(`   Total MCAs: ${summary.total}`);
    console.log(`   ✅ Valid: ${summary.valid}`);
    console.log(`   ❌ Invalid: ${summary.invalid}`);
    if (summary.warnings > 0) {
      console.log(`   ⚠️  Warnings: ${summary.warnings}`);
    }
  }

  // Exit with error if any invalid or (in strict mode) any warnings
  if (summary.invalid > 0) {
    if (!jsonOutput) {
      console.log('\n❌ Validation failed!');
    }
    process.exit(1);
  }

  if (strict && summary.warnings > 0) {
    if (!jsonOutput) {
      console.log('\n❌ Validation failed (strict mode: warnings treated as errors)');
    }
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log('\n✅ All MCAs valid!');
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
