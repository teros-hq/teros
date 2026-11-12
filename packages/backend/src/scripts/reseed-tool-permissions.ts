/**
 * Script: Re-seed tool permissions from manifest annotations
 *
 * Re-applies the install-time permission seed (readOnlyHint → 'allow',
 * mutation → 'ask') to ALREADY-INSTALLED apps, reading each MCA's tools.json
 * from disk. Use it after changing annotations in manifests and deploying:
 * new installs pick the change up automatically (createApp seeds at install
 * time), but existing apps never change retroactively — this script is the
 * retroactive tool.
 *
 * Usage:
 *   bun run src/scripts/reseed-tool-permissions.ts [--dry-run] [--force] [--mca <mcaId>]
 *
 * Options:
 *   --dry-run          Show what would change without writing anything.
 *   --force            Re-seed EVERY app, overwriting user-chosen pins.
 *                      Without it, apps whose map contains any non-'ask'
 *                      entry (a real user decision) are skipped and listed.
 *   --mca <mcaId>      Only process apps of that MCA (e.g. --mca mca.notion).
 *
 * Safety model (same as migration 20260930_001):
 *   - Default mode only touches zero-intent maps: every entry 'ask' and
 *     defaultPermission 'ask' — functionally identical to having no map at
 *     all, so no user decision can be lost.
 *   - --force is destructive to user pins: it restores the install default
 *     everywhere. Run --dry-run --force first to preview.
 */

import { McaToolAnnotationsSchema, type McaToolAnnotations } from '@teros/shared';
import { MongoClient } from 'mongodb';
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AppToolPermissions, ToolPermission } from '../types/database.js';
import { createInstallPermissions } from '../types/permissions.js';

const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename_local);

// tools.json lives at <repo>/mcas/<mcaId>/tools.json. Resolve from the script
// location so it works from any cwd; MCA_BASE_PATH (absolute) overrides.
const MCAS_ROOT = process.env.MCA_BASE_PATH
  ? resolve(process.env.MCA_BASE_PATH)
  : join(__dirname_local, '../../../mcas');

interface ScriptOptions {
  dryRun: boolean;
  force: boolean;
  mcaFilter?: string;
}

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const mcaIdx = args.indexOf('--mca');
  const mcaFilter = mcaIdx !== -1 && args[mcaIdx + 1] ? args[mcaIdx + 1] : undefined;
  return { dryRun, force, mcaFilter };
}

/** Read one MCA's tools.json (name + validated annotations). [] if absent. */
function loadToolDefs(mcaId: string): Array<{ name: string; annotations?: McaToolAnnotations }> {
  const toolsPath = join(MCAS_ROOT, mcaId, 'tools.json');
  try {
    const parsed = JSON.parse(readFileSync(toolsPath, 'utf-8')) as {
      tools?: Array<{ name: string; annotations?: unknown }>;
    };
    if (!Array.isArray(parsed.tools)) {
      console.warn(`⚠️  ${toolsPath} has no tools array — skipping ${mcaId}`);
      return [];
    }
    return parsed.tools.map((t) => {
      const result = t.annotations ? McaToolAnnotationsSchema.safeParse(t.annotations) : null;
      if (t.annotations && !result?.success) {
        console.warn(`⚠️  invalid annotations on tool '${t.name}' (${mcaId}) — treated as mutation`);
      }
      return { name: t.name, annotations: result?.success ? result.data : undefined };
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      console.warn(`⚠️  no tools.json for ${mcaId} (external/retired MCA?) — skipping its apps`);
    } else {
      console.error(`❌ failed to load ${toolsPath}:`, err);
    }
    return [];
  }
}

async function reseedPermissions(options: ScriptOptions): Promise<void> {
  console.log('🔄 Re-seed tool permissions from manifest annotations\n');
  if (options.dryRun) console.log('🔍 DRY RUN MODE — no changes will be made\n');
  if (options.force) {
    console.log('⚡ FORCE MODE — user-chosen pins WILL be overwritten\n');
  }
  if (options.mcaFilter) {
    console.log(`🎯 Scoped to MCA: ${options.mcaFilter}\n`);
  }
  console.log(`📂 MCAs root: ${MCAS_ROOT}\n`);

  if (!existsSync(MCAS_ROOT)) {
    console.error(`❌ MCAs root not found: ${MCAS_ROOT} — set MCA_BASE_PATH to the mcas/ directory`);
    process.exit(1);
  }

  // Load secrets and connect to MongoDB
  const { secrets } = await import('../secrets/secrets-manager.js');
  const secretsPath = join(__dirname_local, '../../../../.secrets');
  (secrets as any).basePath = secretsPath;
  await secrets.load();

  const dbSecret = secrets.system('database');
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || 'mongodb://localhost:27017';
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || 'teros';

  const mongoClient = new MongoClient(mongoUri);

  try {
    await mongoClient.connect();
    const db = mongoClient.db(mongoDatabase);
    const apps = db.collection('apps');

    const query = options.mcaFilter ? { mcaId: options.mcaFilter } : {};
    const allApps = await apps.find(query).toArray();
    console.log(`📊 Found ${allApps.length} installed apps\n`);

    const defsCache = new Map<string, Array<{ name: string; annotations?: McaToolAnnotations }>>();
    const loadDefs = (mcaId: string) => {
      if (!defsCache.has(mcaId)) defsCache.set(mcaId, loadToolDefs(mcaId));
      return defsCache.get(mcaId)!;
    };

    let updated = 0;
    let skippedUserPins = 0;
    let skippedNoManifest = 0;
    let skippedNoChange = 0;
    const userPinnedApps: string[] = [];
    const now = new Date().toISOString();

    for (const app of allApps) {
      const appId = app.appId as string;
      const mcaId = app.mcaId as string;
      const permissions = app.permissions as AppToolPermissions | undefined;
      const tools = permissions?.tools as Record<string, ToolPermission> | undefined;

      const defs = loadDefs(mcaId);
      if (defs.length === 0) {
        skippedNoManifest++;
        continue;
      }

      const seed = createInstallPermissions(defs);

      if (!options.force) {
        // Zero-intent check: any non-'ask' entry (or non-'ask' default) is a
        // real user decision — never touch it in default mode.
        const defaultIsAsk = (permissions?.defaultPermission ?? 'ask') === 'ask';
        const allAsk = defaultIsAsk && (!tools || Object.values(tools).every((v) => v === 'ask'));
        if (!allAsk) {
          skippedUserPins++;
          if (userPinnedApps.length < 50) {
            userPinnedApps.push(`${appId} (${mcaId})`);
          }
          continue;
        }
      }

      const changed = JSON.stringify(seed.tools) !== JSON.stringify(tools ?? {});
      if (!changed) {
        skippedNoChange++;
        continue;
      }

      const allowsBefore = tools ? Object.values(tools).filter((v) => v === 'allow').length : 0;
      const allowsAfter = Object.values(seed.tools).filter((v) => v === 'allow').length;
      console.log(
        `${options.dryRun ? '[dry-run] ' : ''}${appId} (${mcaId}): ` +
          `${allowsBefore} → ${allowsAfter} tools at 'allow'`,
      );

      if (!options.dryRun) {
        await apps.updateOne(
          { appId },
          {
            $set: {
              permissions: { tools: seed.tools, defaultPermission: 'ask' },
              updatedAt: now,
            },
          },
        );
      }
      updated++;
    }

    console.log(`\n📋 Summary:`);
    console.log(`   Re-seeded:            ${updated}${options.dryRun ? ' (dry-run)' : ''}`);
    console.log(`   Unchanged (no diff):  ${skippedNoChange}`);
    console.log(`   Skipped (no manifest): ${skippedNoManifest}`);
    if (!options.force) {
      console.log(`   Skipped (user pins):  ${skippedUserPins}`);
      if (skippedUserPins > 0) {
        console.log(`\n   Apps with user-chosen pins (left untouched):`);
        userPinnedApps.forEach((a) => console.log(`     • ${a}`));
        if (skippedUserPins > userPinnedApps.length) {
          console.log(`     … and ${skippedUserPins - userPinnedApps.length} more`);
        }
        console.log(`\n   Run with --force to overwrite those too (destroys user pins).`);
      }
    }
    console.log('\n✅ Done');
  } catch (error) {
    console.error('❌ Re-seed failed:', error);
    throw error;
  } finally {
    await mongoClient.close();
  }
}

// Run if called directly
// Note: import.meta.main doesn't work with tsx on Node < 21 (undefined there —
// Bun and Node >= 21 define it), so we check if this is the main module too.
const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.main;
if (isMain) {
  reseedPermissions(parseArgs())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { reseedPermissions };
