/**
 * Single source of truth for effective tool permissions.
 *
 * Permissions are pure data, seeded EXPLICITLY at install time by
 * `createInstallPermissions` (read-only → allow, mutation → ask) and owned by
 * the user from then on. There is no read-only auto-allow runtime policy —
 * if the user flips a read tool to `ask`, it asks.
 *
 * The single runtime override is the `alwaysAsk` clamp in
 * `getEffectiveToolPermission`, shared by the runtime gate
 * (mca-tool-executor) and the permissions UI so they never diverge.
 *
 * Annotations are explicit only: the name heuristic was removed 2026-07-04.
 */

import { describe, expect, it } from 'bun:test'
import type { McaToolAnnotations } from '@teros/shared'
import {
  buildToolPermissionsView,
  createInstallPermissions,
  getEffectiveToolPermission,
  isToolAlwaysAsk,
  isToolReadOnly,
} from '../../src/types/permissions'

const app = (
  defaultPermission: 'allow' | 'ask' | 'forbid',
  tools: Record<string, 'allow' | 'ask' | 'forbid'> = {},
) => ({ permissions: { defaultPermission, tools } })

const RO: McaToolAnnotations = { readOnlyHint: true }
const RW: McaToolAnnotations = { readOnlyHint: false }
const LOCKED: McaToolAnnotations = { readOnlyHint: false, alwaysAsk: true }

describe('isToolReadOnly — explicit annotations only', () => {
  it('true only with an explicit readOnlyHint: true', () => {
    expect(isToolReadOnly('export-report', RO)).toBe(true)
    expect(isToolReadOnly('get-and-purge', RW)).toBe(false)
  })
  it('no annotation = mutation (heuristic removed — name is irrelevant)', () => {
    expect(isToolReadOnly('list-items')).toBe(false)
    expect(isToolReadOnly('get-page')).toBe(false)
  })
})

describe('isToolAlwaysAsk', () => {
  it('true only with an explicit alwaysAsk: true', () => {
    expect(isToolAlwaysAsk('install-app', LOCKED)).toBe(true)
    expect(isToolAlwaysAsk('install-app', RW)).toBe(false)
    expect(isToolAlwaysAsk('install-app')).toBe(false)
  })
})

describe('createInstallPermissions — install-time seed', () => {
  const defs = [
    { name: 'get-page', annotations: RO },
    { name: 'create-page', annotations: RW },
    { name: 'delete-page', annotations: RW },
    { name: 'no-annotations-tool' },
    { name: 'install-app', annotations: LOCKED },
    { name: '-health-check', annotations: RO },
  ]

  it('read-only → allow, everything else → ask, private tools skipped', () => {
    const perms = createInstallPermissions(defs)
    expect(perms.tools).toEqual({
      'get-page': 'allow',
      'create-page': 'ask',
      'delete-page': 'ask',
      'no-annotations-tool': 'ask',
      'install-app': 'ask',
    })
    expect(perms.defaultPermission).toBe('ask')
  })

  it('a read-only tool that is confirmation-locked seeds as ask, not allow', () => {
    const perms = createInstallPermissions([
      { name: 'read-secrets', annotations: { readOnlyHint: true, alwaysAsk: true } },
    ])
    expect(perms.tools['read-secrets']).toBe('ask')
  })

  it('empty tool list degrades to plain default-ask', () => {
    const perms = createInstallPermissions([])
    expect(perms).toEqual({ tools: {}, defaultPermission: 'ask' })
  })
})

describe('getEffectiveToolPermission — configured value is what runs', () => {
  it('returns the configured value untouched for normal tools', () => {
    expect(getEffectiveToolPermission(app('ask', { 'get-page': 'allow' }), 'get-page', RO)).toBe('allow')
    expect(getEffectiveToolPermission(app('ask', { 'get-page': 'ask' }), 'get-page', RO)).toBe('ask')
    expect(getEffectiveToolPermission(app('ask'), 'list-items', RO)).toBe('ask') // unseeded → inherited ask
  })
  it('NO read-only auto-allow: user ask on a read tool sticks', () => {
    expect(getEffectiveToolPermission(app('allow', { 'get-page': 'ask' }), 'get-page', RO)).toBe('ask')
  })
  it('treats private tools as allow (via getToolPermission)', () => {
    expect(getEffectiveToolPermission(app('ask'), '-health-check')).toBe('allow')
  })
})

describe('getEffectiveToolPermission — alwaysAsk clamp', () => {
  it('demotes a default allow to ask', () => {
    expect(getEffectiveToolPermission(app('allow'), 'install-app', LOCKED)).toBe('ask')
  })
  it('demotes an explicit per-tool allow to ask (user config cannot unlock)', () => {
    expect(
      getEffectiveToolPermission(app('ask', { 'install-app': 'allow' }), 'install-app', LOCKED),
    ).toBe('ask')
  })
  it('forbid still wins (more restrictive)', () => {
    expect(
      getEffectiveToolPermission(app('ask', { 'install-app': 'forbid' }), 'install-app', LOCKED),
    ).toBe('forbid')
  })
})

describe('buildToolPermissionsView', () => {
  const names = ['get-page', 'create-page', 'delete-page', '-health-check']
  const ann = new Map<string, McaToolAnnotations>([
    ['get-page', RO],
    ['create-page', RW],
    ['delete-page', RW],
  ])

  it('reflects configured permissions and exposes the readOnly flag', () => {
    const seeded = app('ask', { 'get-page': 'allow', 'create-page': 'ask', 'delete-page': 'ask' })
    const { tools, summary } = buildToolPermissionsView(seeded, names, ann)
    // private tool filtered out
    expect(tools.map((t) => t.name)).toEqual(['get-page', 'create-page', 'delete-page'])
    const getPage = tools.find((t) => t.name === 'get-page')!
    expect(getPage.permission).toBe('allow')
    expect(getPage.readOnly).toBe(true)
    expect(tools.find((t) => t.name === 'create-page')!.readOnly).toBe(false)
    expect(summary).toEqual({ allow: 1, ask: 2, forbid: 0 })
  })

  it('user ask on a read-only tool is respected in the summary', () => {
    const pinned = app('ask', { 'get-page': 'ask', 'create-page': 'ask', 'delete-page': 'ask' })
    const { tools, summary } = buildToolPermissionsView(pinned, names, ann)
    expect(tools.find((t) => t.name === 'get-page')!.permission).toBe('ask')
    expect(summary).toEqual({ allow: 0, ask: 3, forbid: 0 })
  })

  it('exposes alwaysAsk so the UI can lock the toggle; effective stays ask under allow', () => {
    const locked = new Map<string, McaToolAnnotations>([['install-app', LOCKED]])
    const { tools, summary } = buildToolPermissionsView(app('allow'), ['install-app'], locked)
    expect(tools[0].alwaysAsk).toBe(true)
    expect(tools[0].permission).toBe('allow') // configured value untouched
    expect(summary).toEqual({ allow: 0, ask: 1, forbid: 0 }) // effective clamped
  })
})
