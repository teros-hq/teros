/**
 * MCA Boot Sync
 *
 * Runs a background sync of MCA tools on backend startup.
 * This is STRICTLY non-blocking — the backend is available immediately.
 *
 * What it does:
 * 1. Reads all tools.json files from mcas/ directory
 * 2. Compares tool list with what's stored in mca_catalog in MongoDB
 * 3. If different, updates the catalog entry
 * 4. Propagates new/removed tools to all installed apps of that MCA
 * 5. Invalidates McaManager's static tools cache for updated MCAs
 *
 * If any MCA fails, logs the error and continues with the rest.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import type { Db } from 'mongodb';
import { join } from 'path';
import type { McpCatalogEntry } from '../types/database';
import type { McaManager } from './mca-manager';
import type { McaService } from './mca-service';

interface ToolsJson {
  $schema?: string;
  mcaId: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: any;
  }>;
}

/**
 * Read tools.json for a single MCA directory.
 * Returns null if tools.json doesn't exist or is invalid.
 */
function readToolsJson(mcasDir: string, mcaDirName: string): ToolsJson | null {
  const toolsPath = join(mcasDir, mcaDirName, 'tools.json');
  if (!existsSync(toolsPath)) {
    return null;
  }

  try {
    const content = readFileSync(toolsPath, 'utf-8');
    return JSON.parse(content) as ToolsJson;
  } catch {
    return null;
  }
}

/**
 * Discover all MCA directories in the mcas/ folder.
 */
function discoverMcaDirs(mcasDir: string): string[] {
  if (!existsSync(mcasDir)) {
    console.warn(`[McaBootSync] MCAs directory not found: ${mcasDir}`);
    return [];
  }

  try {
    const entries = readdirSync(mcasDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
      .map((e) => e.name);
  } catch (error) {
    console.error(`[McaBootSync] Failed to read MCAs directory:`, error);
    return [];
  }
}

/**
 * Check if two sorted tool name arrays are equal.
 */
function toolNamesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((name, i) => name === sortedB[i]);
}

/**
 * Sync a single MCA's tools.json with the catalog.
 * Returns true if catalog was updated, false if unchanged.
 */
async function syncMcaTools(
  db: Db,
  mcasDir: string,
  mcaDirName: string,
  mcaService: McaService,
  mcaManager: McaManager | null,
): Promise<boolean> {
  const toolsJson = readToolsJson(mcasDir, mcaDirName);
  if (!toolsJson) {
    // No tools.json — skip silently (may be a non-tools MCA or not yet generated)
    return false;
  }

  const mcaId = toolsJson.mcaId;
  const newToolNames = toolsJson.tools.map((t) => t.name);

  // Get current catalog entry
  const catalogCollection = db.collection<McpCatalogEntry>('mca_catalog');
  const existing = await catalogCollection.findOne({ mcaId });

  if (!existing) {
    // MCA not in catalog yet — skip (sync-mcas handles initial creation from manifest.json)
    return false;
  }

  // Normalize existing tools — they may be strings or objects (legacy format)
  const existingToolNames = (existing.tools || []).map((t: any) =>
    typeof t === 'string' ? t : t?.name ?? '',
  );

  // Compare tool lists — if same, skip
  if (toolNamesEqual(existingToolNames, newToolNames)) {
    return false;
  }

  const added = newToolNames.filter((t) => !existingToolNames.includes(t));
  const removed = existingToolNames.filter((t) => !newToolNames.includes(t));

  console.log(`[McaBootSync] ${mcaId}: tools changed`);
  if (added.length > 0) console.log(`[McaBootSync] ${mcaId}: + added [${added.join(', ')}]`);
  if (removed.length > 0) console.log(`[McaBootSync] ${mcaId}: - removed [${removed.join(', ')}]`);

  // Update catalog with new tool list
  await catalogCollection.updateOne(
    { mcaId },
    {
      $set: {
        tools: newToolNames,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  // Propagate tool changes to all installed apps of this MCA
  try {
    const propagated = await mcaService.propagateToolsToApps(mcaId, newToolNames);
    if (propagated > 0) {
      console.log(`[McaBootSync] ${mcaId}: propagated tool changes to ${propagated} app(s)`);
    }
  } catch (error) {
    console.error(`[McaBootSync] ${mcaId}: failed to propagate tools to apps:`, error);
    // Non-fatal — continue
  }

  // Invalidate McaManager's static tools cache for this MCA
  if (mcaManager) {
    mcaManager.invalidateStaticToolsCache(mcaId);
    console.log(`[McaBootSync] ${mcaId}: invalidated McaManager cache`);
  }

  return true;
}

/**
 * Run the background MCA boot sync.
 *
 * This function is FIRE-AND-FORGET — it returns immediately without blocking.
 * All work happens asynchronously in the background via setImmediate.
 *
 * @param db - MongoDB database instance
 * @param mcasDir - Path to the mcas/ directory
 * @param mcaService - McaService instance for tool propagation
 * @param mcaManager - McaManager instance for cache invalidation (optional)
 */
export function runMcaBootSync(
  db: Db,
  mcasDir: string,
  mcaService: McaService,
  mcaManager: McaManager | null,
): void {
  // Use setImmediate so the server finishes startup before sync begins
  setImmediate(() => {
    _runMcaBootSyncInternal(db, mcasDir, mcaService, mcaManager).catch((error) => {
      console.error('[McaBootSync] Unexpected error in boot sync:', error);
    });
  });
}

/**
 * Internal async implementation of the boot sync.
 * Processes MCAs sequentially to avoid overwhelming the DB.
 */
async function _runMcaBootSyncInternal(
  db: Db,
  mcasDir: string,
  mcaService: McaService,
  mcaManager: McaManager | null,
): Promise<void> {
  const startTime = Date.now();
  console.log('[McaBootSync] Starting background MCA tools sync...');

  const mcaDirs = discoverMcaDirs(mcasDir);
  console.log(`[McaBootSync] Checking ${mcaDirs.length} MCA directories`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const mcaDirName of mcaDirs) {
    try {
      const wasUpdated = await syncMcaTools(db, mcasDir, mcaDirName, mcaService, mcaManager);
      if (wasUpdated) {
        updated++;
      } else {
        unchanged++;
      }
    } catch (error) {
      failed++;
      console.error(`[McaBootSync] Failed to sync ${mcaDirName}:`, error);
      // Continue with next MCA regardless of error
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[McaBootSync] Done in ${duration}s — updated: ${updated}, unchanged: ${unchanged}, failed: ${failed}`,
  );
}
