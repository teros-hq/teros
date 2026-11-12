/**
 * Contract: every WS action name the frontend client sends must be registered
 * by a backend domain router.
 *
 * Why: the channel handlers were renamed to hyphens (f2f372c5e, 2026-09-21)
 * while ChannelApi kept `channel.toggle_redaction` / `channel.pre_publish_scan`
 * — redaction and the pre-publish warning were dead from the UI for six weeks
 * and nothing caught it (UNKNOWN_ACTION only surfaces at runtime). This test
 * scans both source trees so a rename on either side fails CI.
 *
 * @spec MUW-REQ-5 (pre-publish scan reachable), MUW-REQ-9 (redaction reachable)
 */
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../../..')
const APP_SERVICES = join(ROOT, 'packages/app/src/services')
const BACKEND_SRC = join(ROOT, 'packages/backend/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p)
  }
  return out
}

/** Action names the client sends: `transport.request('domain.action', …)`. */
function clientActions(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of walk(APP_SERVICES)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/request(?:<[^>]*>)?\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) {
      const list = found.get(m[1]) ?? []
      list.push(file.slice(ROOT.length + 1))
      found.set(m[1], list)
    }
  }
  return found
}

/** Action names a backend router registers: `router.register('domain.action', …)`. */
function backendActions(): Set<string> {
  const found = new Set<string>()
  for (const file of walk(BACKEND_SRC)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\.register\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) found.add(m[1])
  }
  return found
}

describe('WS action names: frontend client ↔ backend router', () => {
  it('[MUW-AC-7][MUW-AC-8] every action the client sends is registered by the backend', () => {
    const client = clientActions()
    const backend = backendActions()
    expect(client.size).toBeGreaterThan(100)
    expect(backend.size).toBeGreaterThan(100)

    const missing = [...client.entries()]
      .filter(([action]) => !backend.has(action))
      .map(([action, files]) => `${action}  ← ${files.join(', ')}`)
    expect(missing, `client actions with no backend handler:\n${missing.join('\n')}`).toEqual([])
  })

  it('the MUW channel actions use the hyphenated names the backend registers', () => {
    const client = clientActions()
    expect(client.has('channel.toggle-redaction')).toBe(true)
    expect(client.has('channel.pre-publish-scan')).toBe(true)
    expect(client.has('channel.toggle_redaction')).toBe(false)
    expect(client.has('channel.pre_publish_scan')).toBe(false)
  })
})
