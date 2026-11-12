/**
 * Sync MCA Static Symlinks
 *
 * nginx serves /static/ directly from packages/backend/static/ (alias in the
 * raw-teros site config), so requests for /static/mcas/<id>/... are answered
 * from the filesystem without ever reaching the backend. The backend route
 * (resolveStaticFilePath in bootstrap/http-server.ts) resolves MCA assets from
 * MCA_BASE_PATH and needs no symlinks — but nginx-bypassed requests do.
 *
 * packages/backend/static/mcas/ therefore holds one symlink per MCA:
 *
 *   static/mcas/<mcaId> -> ../../../../mcas/<mcaId>/static
 *
 * These were created (and committed) by hand, so every new MCA 404'd in the
 * catalog until someone remembered to create the link (Telegram, 2026-10-13).
 * This script makes it automatic and idempotent:
 *
 * 1. Scans mcas/ for directories containing a static/ folder
 * 2. Creates missing symlinks in packages/backend/static/mcas/
 * 3. Repairs symlinks whose target drifted from the expected one
 * 4. Removes broken symlinks whose target no longer exists (removed MCAs)
 * 5. Never touches real files/directories — only warns about them
 *
 * Wired into `yarn workspace @teros/backend sync` (package.json), which
 * deploy-server.sh runs on every deploy — new MCAs get their symlink before
 * the backend restarts. Safe to run manually at any time.
 *
 * Usage:
 *   npx tsx src/scripts/sync-mca-static.ts [--dry-run]
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Path to the MCAs source directory (relative to packages/backend/src/scripts)
const MCAS_DIR = join(__dirname, '../../../../mcas')
// nginx serves /static/ from packages/backend/static/ (alias)
const STATIC_MCAS_DIR = join(__dirname, '../../static/mcas')

export interface SyncMcaStaticResult {
  created: string[]
  repaired: string[]
  removed: string[]
  warnings: string[]
  total: number
}

/** Discover MCA directories (mca.*) that ship a static/ folder. */
export function discoverMcasWithStatic(mcasDir: string): string[] {
  if (!existsSync(mcasDir)) {
    console.warn(`[sync-mca-static] MCAs directory not found: ${mcasDir}`)
    return []
  }

  return readdirSync(mcasDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
    .map((e) => e.name)
    .filter((name) => existsSync(join(mcasDir, name, 'static')))
    .sort()
}

function lstatSafe(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * Remove a symlink entry (the link itself — never its target).
 *
 * Node's *sync* unlink family is unreliable for symlinks on some hosts: on
 * Node 24.11 (this box) unlinkSync on a DANGLING symlink throws ENOENT and
 * rmSync either silently no-ops or throws ERR_FS_EISDIR on valid links-to-dir,
 * while fs.promises.unlink and bun handle both fine. So: try the fast sync
 * path, VERIFY the entry actually left the directory, and fall back to the
 * async unlink when it didn't. The verification is the point — never trust
 * the call's return value for a delete.
 */
async function removeSymlink(linkPath: string): Promise<void> {
  try {
    unlinkSync(linkPath)
  } catch {
    // fall through to the verified async path
  }
  if (lstatSafe(linkPath) === null) return // gone
  await fsp.unlink(linkPath)
  if (lstatSafe(linkPath) !== null) {
    throw new Error(`[sync-mca-static] failed to remove symlink: ${linkPath}`)
  }
}

/**
 * Sync symlinks in staticMcasDir so every MCA with static/ assets is served.
 * Idempotent: a second run with no changes is a no-op.
 */
export async function syncMcaStaticSymlinks(options: {
  mcasDir: string
  staticMcasDir: string
  dryRun?: boolean
}): Promise<SyncMcaStaticResult> {
  const { mcasDir, staticMcasDir, dryRun = false } = options
  const result: SyncMcaStaticResult = { created: [], repaired: [], removed: [], warnings: [], total: 0 }

  const mcaIds = discoverMcasWithStatic(mcasDir)
  result.total = mcaIds.length

  if (!existsSync(staticMcasDir)) {
    if (dryRun) {
      console.log(`[sync-mca-static] (dry-run) would create directory: ${staticMcasDir}`)
    } else {
      mkdirSync(staticMcasDir, { recursive: true })
    }
  }

  const expectedTarget = (mcaId: string) => resolve(mcasDir, mcaId, 'static')

  // 1-3. Create missing / repair drifted or dangling symlinks
  for (const mcaId of mcaIds) {
    const linkPath = join(staticMcasDir, mcaId)
    const expected = expectedTarget(mcaId)

    if (!existsSync(linkPath)) {
      if (lstatSafe(linkPath)?.isSymbolicLink()) {
        // Dangling symlink: existsSync is false but the entry is there → repair
        result.repaired.push(mcaId)
        if (!dryRun) {
          await removeSymlink(linkPath)
          symlinkSync(relative(dirname(linkPath), expected), linkPath)
        }
      } else {
        result.created.push(mcaId)
        if (!dryRun) symlinkSync(relative(staticMcasDir, join(mcasDir, mcaId, 'static')), linkPath)
      }
      continue
    }

    const st = lstatSync(linkPath)
    if (!st.isSymbolicLink()) {
      result.warnings.push(
        `${mcaId}: ${linkPath} is a real ${st.isDirectory() ? 'directory' : 'file'}, not a symlink — left untouched`,
      )
      continue
    }

    const current = resolve(staticMcasDir, readlinkSync(linkPath))
    if (current !== expected) {
      result.repaired.push(mcaId)
      if (!dryRun) {
        await removeSymlink(linkPath)
        symlinkSync(relative(dirname(linkPath), expected), linkPath)
      }
    }
  }

  // 4. Remove broken symlinks (MCA removed, or MCA no longer ships static/)
  if (existsSync(staticMcasDir)) {
    for (const entry of readdirSync(staticMcasDir, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue
      const linkPath = join(staticMcasDir, entry.name)
      if (existsSync(linkPath)) continue // valid link — keep

      result.removed.push(entry.name)
      if (!dryRun) await removeSymlink(linkPath)
    }
  }

  return result
}

function printSummary(r: SyncMcaStaticResult, dryRun: boolean): void {
  const prefix = dryRun ? '(dry-run) ' : ''
  if (r.created.length) console.log(`${prefix}Created ${r.created.length} symlink(s): ${r.created.join(', ')}`)
  if (r.repaired.length) console.log(`${prefix}Repaired ${r.repaired.length} symlink(s): ${r.repaired.join(', ')}`)
  if (r.removed.length) console.log(`${prefix}Removed ${r.removed.length} broken symlink(s): ${r.removed.join(', ')}`)
  for (const w of r.warnings) console.warn(`[sync-mca-static] ${w}`)
  if (!r.created.length && !r.repaired.length && !r.removed.length && !r.warnings.length) {
    console.log(`${prefix}All ${r.total} MCA static symlinks up to date`)
  }
}

export async function syncMcaStatic(dryRun = false): Promise<SyncMcaStaticResult> {
  const result = await syncMcaStaticSymlinks({ mcasDir: MCAS_DIR, staticMcasDir: STATIC_MCAS_DIR, dryRun })
  printSummary(result, dryRun)
  return result
}

// Run if called directly
// Note: import.meta.main doesn't work with tsx, so we check if this is the main module
const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.main
if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  syncMcaStatic(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
