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
import { readFileSync } from 'fs'
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

  it('safeWriteHint: a mutating tool with a safe write seeds as allow', () => {
    const SAFE_WRITE: McaToolAnnotations = { readOnlyHint: false, safeWriteHint: true }
    const perms = createInstallPermissions([
      { name: 'save-knowledge', annotations: SAFE_WRITE },
      { name: 'save-conversation', annotations: RW }, // same MCA, no hint → ask
    ])
    expect(perms.tools['save-knowledge']).toBe('allow')
    expect(perms.tools['save-conversation']).toBe('ask')
  })

  it('safeWriteHint loses to alwaysAsk (confirmation lock wins)', () => {
    const perms = createInstallPermissions([
      { name: 'save-knowledge', annotations: { readOnlyHint: false, safeWriteHint: true, alwaysAsk: true } },
    ])
    expect(perms.tools['save-knowledge']).toBe('ask')
  })

  it('safeWriteHint does not change the runtime gate — user ask on a safe-write tool sticks', () => {
    const SAFE_WRITE: McaToolAnnotations = { readOnlyHint: false, safeWriteHint: true }
    expect(getEffectiveToolPermission(app('ask', { 'save-knowledge': 'ask' }), 'save-knowledge', SAFE_WRITE)).toBe('ask')
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

// ---------------------------------------------------------------------------
// Rollout regression (2026-10-01) — pins Pablo's owner decisions on the real
// tools.json manifests. If a future regen or annotation edit silently drops
// safeWriteHint from a SÍ-list tool (or adds it to a NO-list tool), this fails.
// ---------------------------------------------------------------------------

const MCAS_ROOT = '../../mcas'

/** Tools that MUST seed 'allow' (safeWriteHint or readOnlyHint), per MCA. */
const MUST_SEED_ALLOW: Record<string, string[]> = {
  'mca.teros.feedback': ['report-bug', 'report-suggestion'],
  'mca.teros.board-manager': ['add-progress-note'],
  'mca.teros.todo-list': [
    'add-node', 'update-node', 'toggle-complete', 'toggle-collapse',
    'move-node', 'delete-node', 'add-log-entry',
    'set-state', 'set-kind', 'set-progress', 'set-input', 'set-output', 'toggle-instruction-item',
    'plan-node', 'assign-node',
    // To Do autoplay (TODOAP): runners and the manual start; get-autoplay is a read.
    'get-autoplay', 'set-agent-slots', 'set-agent-play', 'set-agent-scope', 'remove-agent', 'start-node',
    // To Do output window (TODOOV): reading the caller's io share link.
    'get-io-share',
  ],
  'mca.teros.board-runner': ['complete-my-task', 'block-my-task', 'cancel-my-task', 'add-progress-note'],
  'mca.teros.file-processor': ['file-to-markdown', 'file-to-markdown-async', 'cancel-job', 'audio-to-text', 'svg-to-png'],
  'mca.teros.conversations': ['create-conversation', 'delegate-task', 'rename-channel', 'import-attachment'],
  'mca.teros.core': ['skill-list', 'workspace-app-list', 'workspace-agent-list', 'skill-get-agent-skills'],
  'mca.teros.messaging': ['notify-by-email'], // readOnlyHint — platform email to the user themselves
  // Playwright (Pablo 2026-10-01): every browser action acts on the agent's OWN
  // browser — reversible, private, non-notifying. 9 pure reads + 18 safe writes.
  'mca.teros.browser': [
    // readOnlyHint — pure reads, touch nothing
    'browser-console-messages', 'browser-console-errors', 'browser-console-clear',
    'browser-network-requests', 'browser-snapshot', 'browser-take-screenshot',
    'browser-tabs', 'browser-wait-for', 'browser-navigate-back',
    // safeWriteHint — actions on the agent's own browser
    'browser-navigate', 'browser-click', 'browser-type', 'browser-fill-form',
    'browser-press-key', 'browser-hover', 'browser-select-option', 'browser-drag',
    'browser-evaluate', 'browser-run-code', 'browser-resize', 'browser-emulate-device',
    'browser-close', 'browser-install', 'browser-handle-dialog',
    'browser-start-recording', 'browser-stop-recording', 'browser-html-to-pdf',
  ],
}

/** Tools that MUST stay 'ask' (owner said NO to safe-write), per MCA. */
const MUST_SEED_ASK: Record<string, string[]> = {
  'mca.teros.board-manager': [
    'subscribe-to-board', 'unsubscribe-from-board',
    'subscribe-to-events', 'unsubscribe-from-events',
    'create-project', 'create-task', 'delete-task', 'move-task',
  ],
  'mca.teros.core': ['skill-create', 'skill-update', 'skill-delete'],
  'mca.teros.conversations': ['send-message'],
  // TODOOV (2026-10-27): publishing or revoking a public link of a task's io
  // is never done by an agent without asking.
  'mca.teros.todo-list': ['share-io', 'unshare-io'],
  // Pablo 2026-10-01: uploads real files to external sites — the only playwright
  // action with an effect outside the agent's own browser. Pure mutation.
  'mca.teros.browser': ['browser-file-upload'],
}

describe('safeWriteHint rollout (2026-10-01) — real tools.json manifests', () => {
  const mcas = new Set([...Object.keys(MUST_SEED_ALLOW), ...Object.keys(MUST_SEED_ASK)])

  const loadSeed = (mcaId: string) => {
    const raw = JSON.parse(
      readFileSync(`${MCAS_ROOT}/${mcaId}/tools.json`, 'utf-8'),
    ) as { tools: Array<{ name: string; annotations?: McaToolAnnotations }> }
    return createInstallPermissions(
      raw.tools.map((t) => ({ name: t.name, annotations: t.annotations })),
    )
  }

  for (const mcaId of mcas) {
    it(`${mcaId}: SÍ-list tools seed allow, NO-list tools stay ask`, () => {
      const seed = loadSeed(mcaId)

      for (const tool of MUST_SEED_ALLOW[mcaId] ?? []) {
        expect(seed.tools[tool], `${mcaId}/${tool} should seed allow`).toBe('allow')
      }
      for (const tool of MUST_SEED_ASK[mcaId] ?? []) {
        expect(seed.tools[tool], `${mcaId}/${tool} should stay ask`).toBe('ask')
      }
    })
  }
})
