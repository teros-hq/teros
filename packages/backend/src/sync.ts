/**
 * Sync Module
 *
 * Runs all sync operations on backend startup:
 * 1. Sync MCAs (manifest.json → mca_catalog collection)
 * 2. Sync Models (model definitions → models collection)
 * 3. Generate MCA tools (spawn MCAs → tools.json)
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Import sync functions
import { syncMcas } from './scripts/sync-mcas';
import { syncModels } from './scripts/sync-models';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Run all sync operations
 */
export async function runSync(options?: { quiet?: boolean }): Promise<void> {
  const quiet = options?.quiet ?? false;
  const log = quiet ? () => {} : console.log.bind(console);

  log('🔄 Running sync...');
  const startTime = Date.now();

  try {
    // 1. Sync MCAs
    log('');
    await syncMcas(false); // false = not dry-run

    // 2. Sync Models
    log('');
    await syncModels(false);

    // 3. Generate MCA tools (run as subprocess since it's outside rootDir)
    // Note: This may exit with code 1 if some MCAs fail (e.g., missing secrets)
    // That's expected - we just log a warning and continue
    log('');
    const scriptsDir = join(__dirname, '../../../scripts');
    const { spawn } = await import('child_process');

    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn('npx', ['tsx', 'generate-mca-tools.ts'], {
        cwd: scriptsDir,
        stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      });

      proc.on('close', (code) => resolve(code ?? 0));
      proc.on('error', reject);
    });

    if (exitCode !== 0) {
      console.warn(`⚠️  generate-mca-tools.ts had some failures (exit code ${exitCode})`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n✅ Sync complete in ${duration}s`);
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  }
}

// Run if called directly
if (import.meta.main) {
  runSync()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
