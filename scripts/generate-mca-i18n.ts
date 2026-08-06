/**
 * generate-mca-i18n.ts
 *
 * Extracts all translatable strings from every MCA's manifest.json and
 * tools.json, and generates an `i18n/en.json` file inside each MCA directory.
 *
 * The English manifest is the source of truth — this script serialises it
 * into a flat JSON structure that other locales (es.json, ko.json, …) can
 * mirror. If an i18n/en.json already exists, it is overwritten (regenerated).
 * Other locale files (es.json, ko.json) are NEVER touched — they are
 * human/LLM-authored and preserved.
 *
 * Output structure (mcas/<mca-id>/i18n/en.json):
 * {
 *   "name": "Bash",
 *   "description": "Execute bash commands on the system...",
 *   "tagline": "Run shell commands",
 *   "changelog": [
 *     { "notes": "Initial release..." }
 *   ],
 *   "tools": {
 *     "bash": {
 *       "name": "Execute bash command",
 *       "description": "Run a bash command with timeout...",
 *       "params": {
 *         "command": "The bash command to execute",
 *         "timeout": "Timeout in milliseconds..."
 *       }
 *     }
 *   }
 * }
 *
 * Usage:  npx tsx scripts/generate-mca-i18n.ts
 */

import * as fs from 'fs'
import * as path from 'path'

const MCAS_DIR = path.resolve(__dirname, '..', 'mcas')

interface ChangelogEntry {
  notes: string
}

interface ToolI18n {
  name: string
  description: string
  params?: Record<string, string>
}

interface McaI18n {
  name?: string
  description?: string
  tagline?: string
  changelog?: ChangelogEntry[]
  tools: Record<string, ToolI18n>
}

function extractMcaI18n(mcaDir: string): McaI18n | null {
  const manifestPath = path.join(mcaDir, 'manifest.json')
  const toolsPath = path.join(mcaDir, 'tools.json')

  if (!fs.existsSync(manifestPath)) return null

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const i18n: McaI18n = { tools: {} }

  // Manifest-level fields
  if (manifest.name) i18n.name = manifest.name
  if (manifest.description) i18n.description = manifest.description
  if (manifest.tagline) i18n.tagline = manifest.tagline

  // Changelog notes
  if (manifest.changelog && Array.isArray(manifest.changelog)) {
    i18n.changelog = manifest.changelog
      .filter((e: any) => e.notes)
      .map((e: any) => ({ notes: e.notes }))
  }

  // Tools
  if (fs.existsSync(toolsPath)) {
    const toolsJson = JSON.parse(fs.readFileSync(toolsPath, 'utf-8'))
    const tools = toolsJson.tools || []

    for (const tool of tools) {
      if (!tool.name) continue

      const toolI18n: ToolI18n = {
        name: tool.name,
        description: tool.description || '',
      }

      // Param descriptions from inputSchema
      const props = tool.inputSchema?.properties || {}
      const params: Record<string, string> = {}
      for (const [propName, propVal] of Object.entries(props)) {
        if (typeof propVal === 'object' && propVal !== null && (propVal as any).description) {
          params[propName] = (propVal as any).description
        }
      }
      if (Object.keys(params).length > 0) {
        toolI18n.params = params
      }

      i18n.tools[tool.name] = toolI18n
    }
  }

  return i18n
}

function main() {
  const entries = fs.readdirSync(MCAS_DIR, { withFileTypes: true })
  let generated = 0
  let skipped = 0

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('mca.')) continue
    // Skip node_modules inside MCA dirs
    if (entry.name.includes('node_modules')) continue

    const mcaDir = path.join(MCAS_DIR, entry.name)
    const i18nDir = path.join(mcaDir, 'i18n')
    const enPath = path.join(i18nDir, 'en.json')

    const i18n = extractMcaI18n(mcaDir)
    if (!i18n) {
      skipped++
      continue
    }

    // Create i18n directory if it doesn't exist
    if (!fs.existsSync(i18nDir)) {
      fs.mkdirSync(i18nDir, { recursive: true })
    }

    // Always overwrite en.json (it's generated from the manifest)
    fs.writeFileSync(enPath, JSON.stringify(i18n, null, 2) + '\n', 'utf-8')
    generated++

    // Report existing locale files
    const existingLocales = fs.readdirSync(i18nDir)
      .filter(f => f.endsWith('.json') && f !== 'en.json')
      .map(f => f.replace('.json', ''))

    if (existingLocales.length > 0) {
      console.log(`  ${entry.name} → en.json ✓ (existing: ${existingLocales.join(', ')})`)
    }
  }

  console.log(`\n📊 Summary:`)
  console.log(`  Generated en.json: ${generated}`)
  console.log(`  Skipped (no manifest): ${skipped}`)
}

main()
