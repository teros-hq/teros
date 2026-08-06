/**
 * "Allow always" must cover the pending requests of the same tool.
 *
 * When the user persists a per-tool permission (allow/forbid), the requests of
 * that same (appId, toolName) that are ALREADY waiting for an answer must be
 * resolved with the new permission — not sit there demanding one click each.
 * The chain under test:
 *
 *   PendingApprovalsRegistry.findPendingByTool   → identity matching
 *   PermissionManager.findPendingRequestIdsForTool + handleResponse
 *                                                → in-flight promises resolve
 *
 * (The wiring from app.update-tool-permission → MessageHandler.
 * applyToolPermissionToPendingRequests is a thin pass-through over these.)
 */

import { describe, expect, it } from 'bun:test'
import { createUpdateToolPermissionHandler } from '../../src/handlers/domains/app/update-tool-permission'
import { PendingApprovalsRegistry } from '../../src/handlers/message/pending-approvals-registry'
import { createPermissionManager } from '../../src/handlers/message/permission-manager'

function makePending(overrides: Partial<Parameters<PendingApprovalsRegistry['register']>[1]> = {}) {
  return {
    resolve: () => {},
    reject: () => {},
    toolName: 'notion_create-page',
    appId: 'app_notion',
    input: {},
    channelId: 'ch_test',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Registry: identity matching
// ---------------------------------------------------------------------------

describe('PendingApprovalsRegistry.findPendingByTool', () => {
  it('returns every pending of the same appId + tool, and nothing else', () => {
    const registry = new PendingApprovalsRegistry()
    registry.register('perm_1', makePending())
    registry.register('perm_2', makePending())
    registry.register('perm_other_tool', makePending({ toolName: 'notion_delete-block' }))
    registry.register('perm_other_app', makePending({ appId: 'app_gmail', toolName: 'gmail_create-page' }))

    const ids = registry.findPendingByTool('app_notion', 'notion_create-page')
    expect(ids.sort()).toEqual(['perm_1', 'perm_2'])
  })

  it('matches on the kebab-normalised short name (namespaced vs bare, _ vs -)', () => {
    const registry = new PendingApprovalsRegistry()
    registry.register('perm_ns', makePending({ toolName: 'notion_create-page' }))

    // Bare catalog name
    expect(registry.findPendingByTool('app_notion', 'create-page')).toEqual(['perm_ns'])
    // Underscore variant of the short name
    expect(registry.findPendingByTool('app_notion', 'notion_create_page')).toEqual(['perm_ns'])
    // Different tool of the same app does not match
    expect(registry.findPendingByTool('app_notion', 'notion_update-page')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PermissionManager: pending promises resolve with the persisted permission
// ---------------------------------------------------------------------------

describe('PermissionManager — persisted permission resolves same-tool pendings', () => {
  async function setup() {
    const broadcasts: any[] = []
    const pm = createPermissionManager({
      broadcastToChannel: (_ch: string, msg: any) => broadcasts.push(msg),
    })
    const ask = pm.createAskPermissionCallback(
      'ch_batch',
      'user_test',
      (toolCallId?: string) => ({ messageId: `m_${toolCallId}`, toolCallId: toolCallId ?? 'tc' }),
      undefined,
    )
    // Three parallel asks of the same tool + one of a different tool
    const sameTool = [
      ask('notion_create-page', 'app_notion', {}, false, 'tc1'),
      ask('notion_create-page', 'app_notion', {}, false, 'tc2'),
      ask('notion_create-page', 'app_notion', {}, false, 'tc3'),
    ]
    const otherTool = ask('notion_delete-block', 'app_notion', {}, false, 'tc4')
    await new Promise((r) => setTimeout(r, 5))
    return { pm, broadcasts, sameTool, otherTool }
  }

  it('grants every pending of the tool; other tools stay pending', async () => {
    const { pm, sameTool } = await setup()

    const ids = pm.findPendingRequestIdsForTool('app_notion', 'notion_create-page')
    expect(ids).toHaveLength(3)
    for (const id of ids) {
      await pm.handleResponse(id, true)
    }

    expect(await Promise.all(sameTool)).toEqual(['granted', 'granted', 'granted'])
    // The other tool's request is untouched
    expect(pm.findPendingRequestIdsForTool('app_notion', 'notion_delete-block')).toHaveLength(1)
    expect(pm.getPendingCount()).toBe(1)
  })

  it('denies every pending of the tool on forbid', async () => {
    const { pm, sameTool } = await setup()

    for (const id of pm.findPendingRequestIdsForTool('app_notion', 'notion_create-page')) {
      await pm.handleResponse(id, false)
    }

    expect(await Promise.all(sameTool)).toEqual(['denied', 'denied', 'denied'])
  })

  it('is idempotent with an individual response racing the bulk resolve', async () => {
    const { pm, sameTool } = await setup()
    const ids = pm.findPendingRequestIdsForTool('app_notion', 'notion_create-page')

    // The user clicks Allow on one widget just before the bulk pass reaches it
    await pm.handleResponse(ids[0], true)
    for (const id of ids) {
      const result = await pm.handleResponse(id, true)
      if (id === ids[0]) expect(result?.idempotent).toBe(true)
    }

    expect(await Promise.all(sameTool)).toEqual(['granted', 'granted', 'granted'])
  })
})

// ---------------------------------------------------------------------------
// app.update-tool-permission handler: fires the pending pass with the clamp
// ---------------------------------------------------------------------------

describe('app.update-tool-permission → applyPermissionToPendingRequests', () => {
  function makeHandler(opts: { alwaysAsk?: boolean } = {}) {
    const applied: Array<{ appId: string; toolName: string; permission: string }> = []
    const app = { appId: 'app_notion', ownerId: 'user_1', name: 'notion', mcaId: 'mca.notion' }
    const mcaService = {
      getApp: async () => app,
      getMcaFromCatalog: async () => ({ name: 'notion', tools: ['create-page', 'delete-block'] }),
      updateToolPermission: async () => ({ ...app, permissions: { tools: {}, defaultPermission: 'ask' } }),
    } as any
    const mcaManager = {
      getToolsForApp: async () => ({
        tools: [
          {
            name: 'notion_create-page',
            annotations: opts.alwaysAsk ? { alwaysAsk: true } : { readOnlyHint: false },
          },
        ],
      }),
    } as any
    const handler = createUpdateToolPermissionHandler(
      mcaService,
      mcaManager,
      undefined,
      async (appId, toolName, permission) => {
        applied.push({ appId, toolName, permission })
        return 1
      },
    )
    return { handler, applied }
  }

  const ctx = { userId: 'user_1' } as any

  it('allow → resolves the pending requests of that tool', async () => {
    const { handler, applied } = makeHandler()
    await handler(ctx, { appId: 'app_notion', toolName: 'notion_create-page', permission: 'allow' })
    await new Promise((r) => setTimeout(r, 5)) // fire-and-forget pass
    expect(applied).toEqual([
      { appId: 'app_notion', toolName: 'notion_create-page', permission: 'allow' },
    ])
  })

  it('forbid → denies the pending requests of that tool', async () => {
    const { handler, applied } = makeHandler()
    await handler(ctx, { appId: 'app_notion', toolName: 'notion_create-page', permission: 'forbid' })
    await new Promise((r) => setTimeout(r, 5))
    expect(applied[0]?.permission).toBe('forbid')
  })

  it('ask → leaves pendings untouched', async () => {
    const { handler, applied } = makeHandler()
    await handler(ctx, { appId: 'app_notion', toolName: 'notion_create-page', permission: 'ask' })
    await new Promise((r) => setTimeout(r, 5))
    expect(applied).toHaveLength(0)
  })

  it('allow on a confirmation-locked tool (alwaysAsk) does NOT auto-grant', async () => {
    const { handler, applied } = makeHandler({ alwaysAsk: true })
    await handler(ctx, { appId: 'app_notion', toolName: 'notion_create-page', permission: 'allow' })
    await new Promise((r) => setTimeout(r, 5))
    expect(applied).toHaveLength(0)
  })

  it('forbid on a confirmation-locked tool still auto-denies (denying is safe)', async () => {
    const { handler, applied } = makeHandler({ alwaysAsk: true })
    await handler(ctx, { appId: 'app_notion', toolName: 'notion_create-page', permission: 'forbid' })
    await new Promise((r) => setTimeout(r, 5))
    expect(applied[0]?.permission).toBe('forbid')
  })
})
