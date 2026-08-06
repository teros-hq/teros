import { describe, it, expect } from 'bun:test'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const LOCALES_DIR = join(
  import.meta.dir,
  '../../../packages/app/src/i18n/locales',
)
const SOURCE_DIR = join(import.meta.dir, '../../../packages/app/src')
const SOURCE_OF_TRUTH = 'en-US.json'

function getLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getLeafKeys(value as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys.sort()
}

async function loadLocale(filename: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(LOCALES_DIR, filename), 'utf-8')
  return JSON.parse(raw)
}

async function getAllLocaleFiles(): Promise<string[]> {
  const files = await readdir(LOCALES_DIR)
  return files.filter((f) => f.endsWith('.json')).sort()
}

async function extractStaticTKeys(
  namespaces: Set<string>,
): Promise<string[]> {
  const keys = new Set<string>()
  const staticPattern = /(?<![a-zA-Z0-9_])t\(['"]([a-zA-Z][a-zA-Z0-9_.]+)['"]/g

  async function walk(dir: string) {
    const { readdir: rd, stat } = await import('fs/promises')
    const entries = await rd(dir)
    for (const entry of entries) {
      const full = join(dir, entry)
      const s = await stat(full)
      if (s.isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue
        await walk(full)
      } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
        const content = await readFile(full, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trimStart()
          if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
          let match: RegExpExecArray | null
          while ((match = staticPattern.exec(line)) !== null) {
            const key = match[1]
            const ns = key.split('.')[0]
            if (namespaces.has(ns)) keys.add(key)
          }
        }
      }
    }
  }

  await walk(SOURCE_DIR)
  return [...keys].sort()
}

describe('i18n locale parity', () => {
  it('all locale files have the same key set as en-US', async () => {
    const files = await getAllLocaleFiles()
    const enUS = await loadLocale(SOURCE_OF_TRUTH)
    const referenceKeys = getLeafKeys(enUS)

    expect(referenceKeys.length).toBeGreaterThan(0)

    const nonEnglish = files.filter((f) => f !== SOURCE_OF_TRUTH)
    expect(nonEnglish.length).toBeGreaterThan(0)

    for (const file of nonEnglish) {
      const locale = await loadLocale(file)
      const localeKeys = getLeafKeys(locale)

      const missingInLocale = referenceKeys.filter(
        (k) => !localeKeys.includes(k),
      )
      const extraInLocale = localeKeys.filter(
        (k) => !referenceKeys.includes(k),
      )

      if (missingInLocale.length > 0) {
        throw new Error(
          `${file} missing ${missingInLocale.length} keys:\n  ${missingInLocale.join('\n  ')}`,
        )
      }
      if (extraInLocale.length > 0) {
        throw new Error(
          `${file} has ${extraInLocale.length} extra keys:\n  ${extraInLocale.join('\n  ')}`,
        )
      }
    }
  })

  it('all locale files have the same key count', async () => {
    const files = await getAllLocaleFiles()
    const counts: Record<string, number> = {}

    for (const file of files) {
      const locale = await loadLocale(file)
      counts[file] = getLeafKeys(locale).length
    }

    const values = Object.values(counts)
    const allSame = values.every((c) => c === values[0])
    if (!allSame) {
      const detail = Object.entries(counts)
        .map(([f, c]) => `${f}: ${c}`)
        .join(', ')
      throw new Error(`Key counts differ: ${detail}`)
    }
  })
})

describe('i18n source coverage', () => {
  it('every static t() key in source resolves to an en-US entry', async () => {
    const enUS = await loadLocale(SOURCE_OF_TRUTH)
    const enKeys = new Set(getLeafKeys(enUS))
    const namespaces = new Set(Object.keys(enUS))
    const sourceKeys = await extractStaticTKeys(namespaces)

    const isResolvable = (key: string) => {
      if (enKeys.has(key)) return true
      // i18next resolves base key to _one/_other when count is passed
      if (enKeys.has(`${key}_other`)) return true
      // key points to a nested object (not a leaf) — i18next returns the object
      const prefix = key + '.'
      if ([...enKeys].some((k) => k.startsWith(prefix))) return true
      return false
    }

    const missing = sourceKeys.filter((k) => !isResolvable(k))

    if (missing.length > 0) {
      const sample = missing.slice(0, 20).join('\n  ')
      throw new Error(`${missing.length} t() keys not in en-US:\n  ${sample}`)
    }
  })
})
