/**
 * Allow read-only tools across all workspaces
 *
 * For every workspace, for every app installed in it, flips every READ-ONLY
 * tool (manifest `annotations.readOnlyHint: true`) whose effective permission
 * is currently 'ask' to an explicit 'allow'.
 *
 * Rules:
 *  - Only 'ask' → 'allow'. Tools already on 'allow' or 'forbid' are untouched.
 *  - `alwaysAsk` tools are never flipped (the runtime clamps them anyway).
 *  - Private tools (name starting with '-') are skipped.
 *  - NOTE: an 'ask' the user pinned by hand IS flipped — this script is a
 *    deliberate operator action ("open up all reads"), not a policy. Don't
 *    run it if you want to preserve hand-tuned asks on read tools.
 *
 * Read-only classification comes from each MCA's tools.json on disk
 * (MCA_BASE_PATH, default ./mcas) — the same source the install seed uses.
 *
 * Usage:
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/allow-read-only-tools.ts            # dry-run (default)
 *   npx tsx --tsconfig packages/backend/tsconfig.json scripts/allow-read-only-tools.ts --apply    # write changes
 *   npx tsx ... allow-read-only-tools.ts --workspace work_teros-v2 [--apply]   # limit to one workspace
 */

import { config as dotenvConfig } from 'dotenv'
import * as fs from 'fs'
import { MongoClient } from 'mongodb'
import * as path from 'path'
import { fileURLToPath } from 'url'

dotenvConfig()

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = 'teros'

// MCA_BASE_PATH in .env is RELATIVE to packages/backend (the backend's cwd),
// so resolving it against this script's cwd usually points nowhere. Try the
// env value first, then fall back to <repoRoot>/mcas. Fail loud if neither
// exists — a silently-missing base path would classify zero tools as
// read-only and report "nothing to flip".
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  ...(process.env.MCA_BASE_PATH ? [path.resolve(process.env.MCA_BASE_PATH)] : []),
  path.join(repoRoot, 'mcas'),
]
const MCA_BASE_PATH = candidates.find((p) => fs.existsSync(path.join(p, 'mca.teros.core')))
if (!MCA_BASE_PATH) {
  console.error(`No MCAs directory found. Tried: ${candidates.join(', ')}`)
  process.exit(1)
}
console.log(`MCAs: ${MCA_BASE_PATH}`)

const APPLY = process.argv.includes('--apply')
const wsFilterIdx = process.argv.indexOf('--workspace')
const WS_FILTER = wsFilterIdx > -1 ? process.argv[wsFilterIdx + 1] : undefined

type ToolPermission = 'allow' | 'ask' | 'forbid'

interface ToolDef {
  name: string
  annotations?: { readOnlyHint?: boolean; alwaysAsk?: boolean }
}

const toolsCache = new Map<string, ToolDef[]>()
function loadTools(mcaId: string): ToolDef[] {
  if (toolsCache.has(mcaId)) return toolsCache.get(mcaId)!
  let defs: ToolDef[] = []
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(MCA_BASE_PATH, mcaId, 'tools.json'), 'utf-8'),
    ) as { tools?: ToolDef[] }
    defs = raw.tools ?? []
  } catch {
    // no tools.json (external/retired MCA) — nothing to flip
  }
  toolsCache.set(mcaId, defs)
  return defs
}

async function main() {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  const db = client.db(DB_NAME)

  try {
    const wsQuery = WS_FILTER ? { workspaceId: WS_FILTER } : {}
    const workspaces = await db.collection('workspaces').find(wsQuery).toArray()
    if (WS_FILTER && workspaces.length === 0) {
      console.error(`Workspace not found: ${WS_FILTER}`)
      process.exit(1)
    }

    let totalApps = 0
    let totalFlips = 0

    for (const ws of workspaces) {
      // ownerType is optional on legacy apps — match both
      const apps = await db
        .collection('apps')
        .find({
          ownerId: ws.workspaceId,
          $or: [{ ownerType: 'workspace' }, { ownerType: { $exists: false } }],
        })
        .toArray()
      if (apps.length === 0) continue

      const lines: string[] = []

      for (const app of apps) {
        const defs = loadTools(app.mcaId as string)
        if (defs.length === 0) continue

        const permissions = (app.permissions ?? { tools: {}, defaultPermission: 'ask' }) as {
          tools: Record<string, ToolPermission>
          defaultPermission?: ToolPermission
        }
        const inherited: ToolPermission = permissions.defaultPermission ?? 'ask'

        const flips: string[] = []
        for (const tool of defs) {
          if (tool.name.startsWith('-')) continue
          if (tool.annotations?.readOnlyHint !== true) continue
          if (tool.annotations?.alwaysAsk === true) continue
          const effective: ToolPermission = permissions.tools[tool.name] ?? inherited
          if (effective !== 'ask') continue
          flips.push(tool.name)
        }

        if (flips.length === 0) continue
        totalApps++
        totalFlips += flips.length
        lines.push(`    ${app.name} (${app.mcaId}): ${flips.length} → allow  [${flips.join(', ')}]`)

        if (APPLY) {
          const $set: Record<string, unknown> = {
            updatedAt: new Date().toISOString(),
            'permissions.defaultPermission': inherited,
          }
          for (const name of flips) $set[`permissions.tools.${name}`] = 'allow'
          await db.collection('apps').updateOne({ appId: app.appId }, { $set })
        }
      }

      if (lines.length > 0) {
        console.log(`\nWorkspace ${ws.workspaceId} — "${ws.name}" (owner: ${ws.ownerId})`)
        for (const line of lines) console.log(line)
      }
    }

    console.log(
      `\n${APPLY ? 'APPLIED' : 'DRY RUN (pass --apply to write)'}: ${totalFlips} tool permission(s) across ${totalApps} app(s) in ${workspaces.length} workspace(s)`,
    )
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
