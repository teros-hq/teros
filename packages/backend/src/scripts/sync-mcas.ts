/**
 * Sync MCAs Script
 *
 * Reads manifest.json files from the mcas/ directory and syncs them
 * with the mca_catalog collection in MongoDB.
 *
 * Usage:
 *   npx tsx src/scripts/sync-mcas.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be synced without making changes
 */

import { formatValidationResult, type MCAManifest, validateMCAManifest } from "@teros/shared"
import { existsSync, readFileSync, statSync } from "fs"
import { readdir, readFile } from "fs/promises"
import * as fs from 'fs'
import * as path from 'path'
import { MongoClient } from "mongodb"
import { dirname, join } from "path"
import { PNG } from "pngjs"
import {
  derivePermissions,
  extractAccentColors,
  humanizeToolDescription,
  toolGroup,
} from "../lib/mca-presentation"
import { fileURLToPath } from "url"
import { config } from "../config"
import { secrets } from "../secrets/secrets-manager"
import { McaService } from "../services/mca-service"
import type { McpCatalogEntry } from "../types/database"
import { getMcaStaticUrl } from "../utils/static-url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to MCAs directory (relative to teros-v2 root)
const MCAS_DIR = join(__dirname, "../../../../mcas")

// ============================================================================
// ICON VALIDATION
// Mirrors the rules in scripts/validate-icons.ts — kept here so validation is
// mandatory in the sync path even when the standalone script is not run.
// Constants must stay in sync with scripts/validate-icons.ts.
// ============================================================================

const ICON_MIN_DIMENSION = 256 // px
const ICON_MAX_FILE_SIZE = 150 * 1024 // 150 KB
const ICON_MIN_FILE_SIZE = 5 * 1024 // < 5 KB → suspiciously small / placeholder
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_MIN_VARIANCE = 20 // solid-color placeholder threshold

function isPngBuffer(buf: Buffer): boolean {
  return buf.length >= 8 && PNG_MAGIC.every((byte, i) => buf[i] === byte)
}

/** Sample pixel variance to detect solid-color placeholders. */
function computePixelVariance(png: PNG): number {
  const data = png.data
  const totalPixels = png.width * png.height
  const step = 16
  let sumR = 0,
    sumG = 0,
    sumB = 0,
    count = 0

  for (let i = 0; i < totalPixels; i += step) {
    const o = i * 4
    sumR += data[o]
    sumG += data[o + 1]
    sumB += data[o + 2]
    count++
  }
  if (count === 0) return 0
  const mR = sumR / count,
    mG = sumG / count,
    mB = sumB / count
  let vR = 0,
    vG = 0,
    vB = 0
  for (let i = 0; i < totalPixels; i += step) {
    const o = i * 4
    vR += (data[o] - mR) ** 2
    vG += (data[o + 1] - mG) ** 2
    vB += (data[o + 2] - mB) ** 2
  }
  return (vR + vG + vB) / (3 * count)
}

/**
 * Validate the icon file for an MCA and, in the same read, extract the brand
 * accent colours used for the hero gradient (TER-538). Returns both so the PNG
 * is decoded only once. `errors` empty means valid; `accentColors` empty means
 * monochrome/unreadable (the client falls back to the accent).
 * Mirrors validateMcaIcon() in scripts/validate-icons.ts.
 */
function validateIcon(mcaId: string, iconField: string): { errors: string[]; accentColors: string[] } {
  const errors: string[] = []

  // Resolve path — try static/ first (documented convention), then MCA root
  const mcaDir = join(MCAS_DIR, mcaId)
  const iconPath =
    [join(mcaDir, "static", iconField), join(mcaDir, iconField)].find((p) => existsSync(p)) ?? null

  if (!iconPath) {
    return {
      errors: [`icon file not found: "${iconField}" (tried static/${iconField} and ${iconField})`],
      accentColors: [],
    }
  }

  const fileSizeBytes = statSync(iconPath).size

  if (fileSizeBytes < ICON_MIN_FILE_SIZE) {
    errors.push(
      `icon file too small: ${fileSizeBytes} bytes (< ${ICON_MIN_FILE_SIZE} bytes) — likely a placeholder`,
    )
  }
  if (fileSizeBytes > ICON_MAX_FILE_SIZE) {
    errors.push(
      `icon file too large: ${Math.round(fileSizeBytes / 1024)} KB (max ${ICON_MAX_FILE_SIZE / 1024} KB)`,
    )
  }

  const buf = readFileSync(iconPath)

  if (!isPngBuffer(buf)) {
    errors.push("icon is not a valid PNG file (wrong magic bytes)")
    return { errors, accentColors: [] }
  }

  let png: PNG
  try {
    png = PNG.sync.read(buf)
  } catch (err: any) {
    errors.push(`icon PNG decode failed: ${err.message}`)
    return { errors, accentColors: [] }
  }

  // Extract brand accent colours from the decoded PNG (single read).
  const accentColors = extractAccentColors(png)

  const { width, height } = png

  if (width !== height) {
    errors.push(`icon is not square: ${width}×${height} px — width must equal height`)
  }

  const minDim = Math.min(width, height)
  if (minDim < ICON_MIN_DIMENSION) {
    errors.push(
      `icon too small: ${width}×${height} px (minimum ${ICON_MIN_DIMENSION}×${ICON_MIN_DIMENSION} px)`,
    )
  }

  // Placeholder detection — only for small files (large files are unlikely to be solid fills)
  if (fileSizeBytes < ICON_MIN_FILE_SIZE * 2) {
    const variance = computePixelVariance(png)
    if (variance < ICON_MIN_VARIANCE) {
      errors.push(
        `icon appears to be a placeholder: near-uniform pixel content (variance=${variance.toFixed(1)}, threshold=${ICON_MIN_VARIANCE}) — solid-color fills are not acceptable`,
      )
    }
  }

  return { errors, accentColors }
}

/**
 * Tools.json schema (auto-generated by generate-mca-tools.ts)
 */
interface ToolsJson {
  $schema?: string
  mcaId: string
  tools: Array<{
    name: string
    description: string
    inputSchema: any
    /** Author-curated catalog presentation (TER-538); falls back to heuristic. */
    annotations?: { summary?: string; group?: string }
  }>
}

/**
 * Build the full icon URL from manifest icon field
 *
 * If icon is a relative path (e.g., 'icon.svg'), it's treated as an MCA static asset
 * If icon is already a full URL (starts with http), it's used as-is
 */
function buildIconUrl(mcaId: string, icon?: string): string | undefined {
  if (!icon) return undefined

  // If already a full URL, use as-is
  if (icon.startsWith("http://") || icon.startsWith("https://")) {
    return icon
  }

  // Otherwise, treat as relative path within MCA's static folder
  return getMcaStaticUrl(mcaId, icon)
}

/**
 * Extract auth configuration from layers for database storage
 */
function extractAuthConfig(manifest: MCAManifest): McpCatalogEntry["auth"] {
  const auth = manifest.layers.auth
  if (auth === false) return undefined

  if (auth.type === "oauth2") {
    return {
      type: "oauth2",
      provider: auth.provider,
      authorizeUrl: auth.authorizeUrl,
      tokenUrl: auth.tokenUrl,
      scopes: auth.scopes,
      ...(auth.optionalScopes && auth.optionalScopes.length > 0 ? { optionalScopes: auth.optionalScopes } : {}),
      ...(auth.scopeSeparator ? { scopeSeparator: auth.scopeSeparator } : {}),
      pkce: auth.pkce,
      ...(auth.extraFields && auth.extraFields.length > 0 ? { extraFields: auth.extraFields } : {}),
    }
  }

  if (auth.type === "api-key") {
    return { type: "apikey" }
  }

  if (auth.type === "agent") {
    return {
      type: "agent",
      ...(auth.instructions ? { instructions: auth.instructions } : {}),
    }
  }

  if (auth.type === "github-app") {
    return {
      type: "github-app",
      provider: auth.provider,
      appSlug: auth.appSlug,
      setupUrl: auth.setupUrl,
      permissions: auth.permissions,
      events: auth.events,
      ...(auth.userOAuth ? { userOAuth: true } : {}),
      ...(auth.tokenUrl ? { tokenUrl: auth.tokenUrl } : {}),
    }
  }

  return undefined
}

/**
 * Extract secrets from layers for database storage
 */
function extractSecrets(manifest: MCAManifest): { systemSecrets: string[]; userSecrets: string[] } {
  const auth = manifest.layers.auth
  if (auth === false) {
    return { systemSecrets: [], userSecrets: [] }
  }
  return {
    systemSecrets: auth.systemSecrets || [],
    userSecrets: auth.userSecrets || [],
  }
}

/**
 * Load i18n files from mcas/<mca-id>/i18n/*.json.
 * Returns a map of locale → translation object.
 * The en.json is always present (generated by generate-mca-i18n.ts).
 * Other locales (es, ko, …) are optional and human/LLM-authored.
 */
function loadMcaI18n(mcaDir: string): Record<string, any> | undefined {
  const i18nDir = path.join(mcaDir, 'i18n')
  if (!fs.existsSync(i18nDir)) return undefined

  const result: Record<string, any> = {}
  const files = fs.readdirSync(i18nDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    const locale = file.replace('.json', '')
    try {
      const content = fs.readFileSync(path.join(i18nDir, file), 'utf-8')
      result[locale] = JSON.parse(content)
    } catch (e) {
      console.warn(`  ⚠ Could not parse i18n/${file} for ${mcaDir}`)
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Convert manifest to catalog entry
 */
function manifestToCatalogEntry(
  manifest: MCAManifest,
  mcaDir: string,
  tools: string[],
  toolsDetailed: Array<{ name: string; description: string; group?: string }>,
  accentColors: string[],
  mcaI18n?: Record<string, any>,
): McpCatalogEntry {
  const now = new Date().toISOString()

  // Determine command based on entrypoint
  const entrypoint = manifest.entrypoint
  let command = "tsx"
  let args = [entrypoint]

  // If entrypoint is a .js file, use node directly
  if (entrypoint.endsWith(".js")) {
    command = "node"
    args = [entrypoint]
  }

  // Availability from manifest (now required)
  const availability = {
    enabled: manifest.availability.enabled,
    multi: manifest.availability.multi,
    system: manifest.availability.system,
    hidden: manifest.availability.hidden ?? false,
    role: manifest.availability.role,
  }

  // Extract auth and secrets from layers
  const { systemSecrets, userSecrets } = extractSecrets(manifest)
  const auth = extractAuthConfig(manifest)

  return {
    mcaId: manifest.id,
    name: manifest.name,
    description: manifest.description,
    execution: {
      command,
      args,
      cwd: mcaDir, // Directory name (e.g., 'mca.teros.bash')
    },
    availability,
    // Auth configuration extracted from layers
    systemSecrets,
    userSecrets,
    auth,
    // Legacy schemas (deprecated)
    secretsSchema: undefined,
    authSchema: undefined,
    tools,
    toolsDetailed,
    // Presentation derived once at sync (TER-538): brand colours from the icon
    // for the hero gradient, and runtime permissions for the detail view.
    accentColors,
    permissions: derivePermissions(manifest.runtime),
    category: manifest.category,
    icon: buildIconUrl(manifest.id, manifest.icon),
    color: manifest.color,
    // Catalog presentation fields (TER-524) — propagated for the detail view.
    version: manifest.version,
    author: manifest.author,
    keywords: manifest.keywords,
    image: manifest.image,
    backgroundImage: manifest.backgroundImage,
    tagline: manifest.tagline,
    screenshots: manifest.screenshots,
    changelog: manifest.changelog,
    verified: manifest.verified,
    homepage: manifest.homepage ?? manifest.author?.url,
    runtime: manifest.runtime,
    i18n: mcaI18n,
    status: availability.enabled ? "active" : "disabled",
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Read all MCA manifests from the mcas directory with validation
 */
async function readManifests(): Promise<
  Map<string, { manifest: MCAManifest; dir: string; tools: string[]; toolsDetailed: Array<{ name: string; description: string; group?: string }>; accentColors: string[] }>
> {
  const manifests = new Map<
    string,
    { manifest: MCAManifest; dir: string; tools: string[]; toolsDetailed: Array<{ name: string; description: string; group?: string }>; accentColors: string[] }
  >()
  let hasErrors = false

  try {
    const entries = await readdir(MCAS_DIR, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith("mca.")) continue

      const manifestPath = join(MCAS_DIR, entry.name, "manifest.json")
      const toolsPath = join(MCAS_DIR, entry.name, "tools.json")

      // A directory without manifest.json is not a syncable MCA (e.g. a
      // work-in-progress skeleton). Skip it instead of aborting the whole
      // all-or-nothing sync.
      if (!existsSync(manifestPath)) {
        console.warn(`  ⚠️  WARNING: ${entry.name} — no manifest.json, skipping (not a syncable MCA)`)
        continue
      }

      try {
        const content = await readFile(manifestPath, "utf-8")
        let data: unknown

        try {
          data = JSON.parse(content)
        } catch (parseErr) {
          console.error(`  ❌ ${entry.name}: Invalid JSON in manifest.json`)
          hasErrors = true
          continue
        }

        // Validate manifest against schema
        const validation = validateMCAManifest(data)

        if (!validation.valid) {
          console.error(formatValidationResult(entry.name, validation))
          hasErrors = true
          continue
        }

        const manifest = validation.manifest!

        // Show warnings but continue
        if (validation.warnings.length > 0) {
          console.warn(`  ⚠️  ${manifest.id}: ${validation.warnings.length} warning(s)`)
          validation.warnings.forEach((w) => {
            console.warn(`      - ${w.path}: ${w.message}`)
          })
        }

        // ── Icon validation (non-blocking warning) ───────────────────────────
        // Icon problems are surfaced as loud, actionable warnings but do NOT
        // block the sync.  The MCA is still written to the catalog so that
        // development and CI are not halted by a missing or placeholder icon.
        //
        // To enforce strict icon quality in a separate gate (e.g. pre-commit or
        // CI), run:  npx tsx scripts/validate-icons.ts
        let accentColors: string[] = []
        if (manifest.icon) {
          const { errors: iconErrors, accentColors: extracted } = validateIcon(entry.name, manifest.icon)
          accentColors = extracted
          if (iconErrors.length > 0) {
            console.warn(`\n  ⚠️  WARNING: ${entry.name} — icon validation failed (sync continues)`)
            iconErrors.forEach((e) => console.warn(`      [icon] ${e}`))
            console.warn(
              `      → Fix the icon at mcas/${entry.name}/static/${manifest.icon} and re-run sync.\n`,
            )
          }
        }

        // Read tools from tools.json. `tools` keeps names only (counts,
        // back-compat); `toolsDetailed` carries the *human* description + the
        // derived domain `group` the detail view renders. The agent-facing
        // description stays in tools.json — it is NOT regenerated here.
        let tools: string[] = []
        let toolsDetailed: Array<{ name: string; description: string; group?: string }> = []
        try {
          const toolsContent = await readFile(toolsPath, "utf-8")
          const toolsJson = JSON.parse(toolsContent) as ToolsJson
          tools = toolsJson.tools.map((t) => t.name)
          // Author-curated presentation (annotations.summary/group) wins; the
          // heuristic is only a fallback when the MCA hasn't declared it.
          toolsDetailed = toolsJson.tools.map((t) => ({
            name: t.name,
            description: t.annotations?.summary?.trim() || humanizeToolDescription(t.description ?? ""),
            group: t.annotations?.group?.trim() || toolGroup(t.name),
          }))
        } catch {
          if (manifest.layers.tools) {
            console.warn(`  ⚠ No tools.json for ${entry.name} (but layers.tools is true)`)
          }
        }

        manifests.set(manifest.id, { manifest, dir: entry.name, tools, toolsDetailed, accentColors })
        console.log(`  ✓ Valid: ${manifest.id} (${manifest.name}) - ${tools.length} tools`)
      } catch (err) {
        console.error(`  ❌ ${entry.name}: ${err instanceof Error ? err.message : "Unknown error"}`)
        hasErrors = true
      }
    }
  } catch (err) {
    console.error(`Error reading MCAs directory: ${err}`)
  }

  if (hasErrors) {
    console.error("\n❌ Some MCAs have validation errors. Fix them before syncing.")
    process.exit(1)
  }

  return manifests
}

/**
 * Sync manifests with database
 */
async function syncMcas(dryRun: boolean = false) {
  console.log("🔄 Syncing MCAs with database...\n")
  console.log(`MCAs directory: ${MCAS_DIR}\n`)

  // Read all manifests
  console.log("📂 Reading manifests...")
  const manifests = await readManifests()
  console.log(`\nFound ${manifests.size} MCAs\n`)

  if (manifests.size === 0) {
    console.log("No MCAs found. Nothing to sync.")
    return
  }

  // Load secrets and connect to MongoDB
  const secretsPath = join(__dirname, "../../../../.secrets")
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  const dbSecret = secrets.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"

  const mongoClient = new MongoClient(mongoUri)

  try {
    await mongoClient.connect()
    const db = mongoClient.db(mongoDatabase)
    const catalogCollection = db.collection<McpCatalogEntry>("mca_catalog")

    // Get existing entries
    const existing = await catalogCollection.find({}).toArray()
    const existingMap = new Map(existing.map((e) => [e.mcaId, e]))

    console.log(`📊 Database has ${existing.length} existing entries\n`)

    // Determine changes - always force update for existing entries
    const toInsert: McpCatalogEntry[] = []
    const toUpdate: McpCatalogEntry[] = []

    for (const [mcaId, { manifest, dir, tools, toolsDetailed, accentColors }] of manifests) {
      const catalogEntry = manifestToCatalogEntry(manifest, dir, tools, toolsDetailed, accentColors, loadMcaI18n(join(MCAS_DIR, dir)))
      const existingEntry = existingMap.get(mcaId)

      if (!existingEntry) {
        toInsert.push(catalogEntry)
      } else {
        // Always update - preserve original createdAt timestamp
        catalogEntry.createdAt = existingEntry.createdAt
        catalogEntry.updatedAt = new Date().toISOString()
        toUpdate.push(catalogEntry)
      }
    }

    // Find entries in DB that no longer have manifests (orphans)
    const manifestIds = new Set(manifests.keys())
    const orphans = existing.filter((e) => !manifestIds.has(e.mcaId))

    // Report changes
    console.log("📋 Changes:")

    if (toInsert.length > 0) {
      console.log(`\n  New MCAs (${toInsert.length}):`)
      toInsert.forEach((e) => console.log(`    + ${e.mcaId} (${e.name})`))
    }

    if (toUpdate.length > 0) {
      console.log(`\n  Synced MCAs (${toUpdate.length}):`)
      toUpdate.forEach((e) => console.log(`    ~ ${e.mcaId} (${e.name})`))
    }

    if (orphans.length > 0) {
      console.log(`\n  🗑️  Orphaned catalog entries (no manifest found):`)
      orphans.forEach((e) => console.log(`    - ${e.mcaId} (${e.name})`))
    }

    // Apply changes
    if (dryRun) {
      console.log("\n🔍 DRY RUN - No changes applied\n")
    } else {
      console.log("\n💾 Applying changes...")

      // Insert new entries
      if (toInsert.length > 0) {
        await catalogCollection.insertMany(toInsert)
        console.log(`  Inserted ${toInsert.length} new entries`)
      }

      // Update existing entries
      for (const entry of toUpdate) {
        await catalogCollection.updateOne({ mcaId: entry.mcaId }, { $set: entry })
      }
      if (toUpdate.length > 0) {
        console.log(`  Updated ${toUpdate.length} entries`)
      }

      // Delete orphaned catalog entries (mcaId no longer has a manifest)
      if (orphans.length > 0) {
        const orphanIds = orphans.map((e) => e.mcaId)
        await catalogCollection.deleteMany({ mcaId: { $in: orphanIds } })
        console.log(`  Deleted ${orphans.length} orphaned catalog entries`)
      }

      console.log("\n✅ Sync complete!\n")

      // Delete orphaned apps (apps whose mcaId no longer exists in the active catalog)
      console.log("🧹 Checking for orphaned installed apps...")
      const mcaService = new McaService(db)
      const activeMcaIds = new Set(manifests.keys())
      const { deleted } = await mcaService.deleteOrphanedApps(activeMcaIds)

      if (deleted.length > 0) {
        console.log(`  🗑️  Deleted ${deleted.length} orphaned apps:`)
        deleted.forEach((a) => console.log(`    - ${a.appId} (${a.mcaId} / ${a.name})`))
      } else {
        console.log("  No orphaned apps found")
      }
    }

    // Summary
    console.log("\n📊 Summary:")
    console.log(`  Total MCAs in filesystem: ${manifests.size}`)
    console.log(`  Total entries in database: ${existing.length + toInsert.length}`)
    console.log(`  Inserted: ${toInsert.length}`)
    console.log(`  Synced: ${toUpdate.length}`)
    if (orphans.length > 0) {
      console.log(`  Deleted from catalog: ${orphans.length} orphaned entries`)
    }
  } catch (error) {
    console.error("Error syncing MCAs:", error)
    throw error
  } finally {
    await mongoClient.close()
  }
}

// Run if called directly
// Note: import.meta.main doesn't work with tsx, so we check if this is the main module
const isMain = import.meta.url === `file://${process.argv[1]}` || import.meta.main
if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")

  syncMcas(dryRun)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

export { syncMcas }
