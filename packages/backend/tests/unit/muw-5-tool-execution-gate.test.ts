/**
 * MUW-5: App scoping + tool execution gate (REQ-6, REQ-7, AC-8, AC-9).
 *
 * Tests:
 *   AC-8: Personal app blocked in public conversation
 *   AC-9: Personal app works in private conversation
 *   Shared app works in both public and private
 *   Scope change does not affect historical content (gate is per-execution, not retroactive)
 *   McaService.setAppScope updates the appScope field
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { Db } from 'mongodb'
import { McaToolExecutor } from '../../src/services/mca-tool-executor'
import type { McaManager, ToolDefinition } from '../../src/services/mca-manager'
import { McaService } from '../../src/services/mca-service'
import type { App, AgentAppAccess, AppToolPermissions } from '../../src/types/database'

// ─── Mock helpers ──────────────────────────────────────────────────────────────

const CHANNEL_ID = 'ch_test_muw5'
const AGENT_ID = 'agent_test'
const USER_ID = 'user_test'
const WORKSPACE_ID = 'ws_test'
const PERSONAL_APP_ID = 'app_personal'
const SHARED_APP_ID = 'app_shared'

function makeApp(overrides: Partial<App> = {}): App {
  return {
    appId: PERSONAL_APP_ID,
    mcaId: 'mca.test',
    ownerId: WORKSPACE_ID,
    ownerType: 'workspace',
    name: 'test-app',
    scope: 'personal',
    installedBy: USER_ID, // MUW-AC-4: the member who installed it
    permissions: {
      tools: {},
      defaultPermission: 'allow',
    },
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    ...overrides,
  }
}

function makeToolDef(appName: string, toolName: string): ToolDefinition {
  return {
    name: `${appName}_${toolName}`,
    description: `Test tool ${toolName}`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  }
}

function createMockMcaManager(): McaManager {
  return {
    registerApp: mock(() => Promise.resolve()),
    getToolsForApp: mock(() =>
      Promise.resolve({
        tools: [makeToolDef('test-app', 'do-thing')],
        status: 'standby' as const,
      }),
    ),
    executeTool: mock(() =>
      Promise.resolve({
        output: JSON.stringify({ success: true }),
        isError: false,
        mcaId: 'mca.test',
      }),
    ),
    getMcaIdForTool: mock(() => 'mca.test'),
  } as unknown as McaManager
}

function createMockMcaService(apps: App[]): McaService {
  const appMap = new Map(apps.map((a) => [a.appId, a]))

  return {
    getApp: mock((appId: string) => Promise.resolve(appMap.get(appId) ?? null)),
    // MUW-REQ-12 gate predicate — the real one, so the suite tests the rule, not a copy.
    isAppUsableBy: McaService.prototype.isAppUsableBy,
    getAgentApps: mock(() =>
      Promise.resolve({
        agentId: AGENT_ID,
        apps: apps.map((app) => ({
          app: {
            ...app,
            mca: {
              mcaId: app.mcaId,
              name: 'Test MCA',
              description: 'Test',
              category: 'utility',
              availability: { enabled: true, multi: false, system: false, hidden: false, role: 'user' },
              execution: { command: 'node', args: [] },
              tools: [],
              status: 'active',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          },
          access: {
            agentId: AGENT_ID,
            appId: app.appId,
            grantedBy: USER_ID,
            grantedAt: '2026-09-14T00:00:00Z',
            permissions: app.permissions,
          } as AgentAppAccess,
        })),
      }),
    ),
    hasAccess: mock(() => Promise.resolve(true)),
  } as unknown as McaService
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MUW-5: App scoping + tool execution gate', () => {
  let mcaManager: McaManager
  let mcaService: McaService
  let personalApp: App
  let sharedApp: App

  beforeEach(() => {
    personalApp = makeApp({
      appId: PERSONAL_APP_ID,
      name: 'personal-app',
      scope: 'personal',
    })
    sharedApp = makeApp({
      appId: SHARED_APP_ID,
      name: 'shared-app',
      scope: 'shared',
    })
    mcaManager = createMockMcaManager()
    mcaService = createMockMcaService([personalApp, sharedApp])
  })

  /**
   * Helper: create an initialized executor with the given channel visibility.
   * Tools are pre-cached so we can call executeTool directly.
   */
  async function createExecutor(
    visibility: 'personal' | 'shared' | undefined,
    appIds: string[] = [PERSONAL_APP_ID, SHARED_APP_ID],
  ): Promise<McaToolExecutor> {
    const executor = new McaToolExecutor(mcaManager, mcaService, AGENT_ID, CHANNEL_ID, {
      workspaceId: WORKSPACE_ID,
    })
    executor.setUserContext(USER_ID, WORKSPACE_ID, 'Test User', undefined, false, false, visibility)
    // MUW-REQ-12: the conversation decides the app set — the executor re-reads
    // the channel viewer on every policy check, so the mock must answer with
    // the scope this case exercises (undefined = legacy channel, no scope).
    ;(mcaService as any).getChannelViewer = mock(async () => ({ userId: USER_ID, channelScope: visibility }))

    // Mock initialize: set appIds and populate tool cache
    ;(executor as any).appIds = appIds
    ;(executor as any).initialized = true

    // Populate tool cache for each app
    const cachedTools: ToolDefinition[] = []
    const toolToAppId = new Map<string, string>()
    for (const appId of appIds) {
      const app = appId === PERSONAL_APP_ID ? personalApp : sharedApp
      const tool = makeToolDef(app.name, 'do-thing')
      cachedTools.push(tool)
      toolToAppId.set(tool.name, appId)
    }
    ;(executor as any).cachedTools = cachedTools
    ;(executor as any).toolToAppId = toolToAppId

    return executor
  }

  describe('AC-8: Personal app blocked in public conversation', () => {
    test('personal app tool → blocked with PERSONAL_APP_BLOCKED message', async () => {
      const executor = await createExecutor('shared')

      const result = await executor.executeTool('personal-app_do-thing', {})

      expect(result.isError).toBe(true)
      expect(result.output).toContain('PERSONAL_APP_BLOCKED')
      expect(result.permissionDenied).toBe(true)
    })

    test('personal app tool → McaManager.executeTool is NOT called', async () => {
      const executor = await createExecutor('shared')
      await executor.executeTool('personal-app_do-thing', {})

      expect((mcaManager.executeTool as any).mock.calls.length).toBe(0)
    })

    test('undefined scope (legacy) → personal app allowed (missing scope is treated as personal)', async () => {
      const executor = await createExecutor(undefined)

      const result = await executor.executeTool('personal-app_do-thing', {})

      expect(result.isError).toBe(false)
    })
  })

  describe('AC-9: Personal app works in private conversation', () => {
    test('personal app tool → succeeds in private channel', async () => {
      const executor = await createExecutor('personal')

      const result = await executor.executeTool('personal-app_do-thing', {})

      expect(result.isError).toBe(false)
      expect(result.output).toContain('success')
    })

    test('personal app tool → McaManager.executeTool IS called', async () => {
      const executor = await createExecutor('personal')
      await executor.executeTool('personal-app_do-thing', {})

      expect((mcaManager.executeTool as any).mock.calls.length).toBe(1)
    })
  })

  describe('Shared app works in both public and private', () => {
    test('shared app tool → succeeds in public channel', async () => {
      const executor = await createExecutor('shared')

      const result = await executor.executeTool('shared-app_do-thing', {})

      expect(result.isError).toBe(false)
      expect(result.output).toContain('success')
    })

    test('shared app tool → succeeds in private channel', async () => {
      const executor = await createExecutor('personal')

      const result = await executor.executeTool('shared-app_do-thing', {})

      expect(result.isError).toBe(false)
      expect(result.output).toContain('success')
    })
  })

  describe('Scope change does not affect historical content', () => {
    test('changing scope from shared to personal blocks NEW executions but does not touch history', async () => {
      // Start with a shared app in a public channel — execution succeeds
      const executor = await createExecutor('shared', [SHARED_APP_ID])
      const result1 = await executor.executeTool('shared-app_do-thing', {})
      expect(result1.isError).toBe(false)

      // Now change the app to personal scope (simulating setAppScope)
      sharedApp.scope = 'personal'

      // Create a new executor for the new turn (simulates fresh turn)
      const executor2 = await createExecutor('shared', [SHARED_APP_ID])
      const result2 = await executor2.executeTool('shared-app_do-thing', {})

      // New execution is blocked
      expect(result2.isError).toBe(true)
      expect(result2.output).toContain('PERSONAL_APP_BLOCKED')

      // But the first result is unchanged — historical content is not retroactively modified
      expect(result1.isError).toBe(false)
    })

    test('changing scope from personal to shared allows NEW executions', async () => {
      // Start with personal app in public — blocked
      const executor = await createExecutor('shared', [PERSONAL_APP_ID])
      const result1 = await executor.executeTool('personal-app_do-thing', {})
      expect(result1.isError).toBe(true)

      // Change to shared
      personalApp.scope = 'shared'

      // New executor for new turn
      const executor2 = await createExecutor('shared', [PERSONAL_APP_ID])
      const result2 = await executor2.executeTool('personal-app_do-thing', {})

      // Now it succeeds
      expect(result2.isError).toBe(false)
    })
  })
})

// ─── McaService.setAppScope tests ──────────────────────────────────────────────

describe('MUW-5: McaService.setAppScope', () => {
  test('setAppScope updates the scope field for the app owner (MUW-REQ-11)', async () => {
    // Minimal mock that captures the update
    const app = makeApp({ appId: 'app_test', scope: 'shared', installedBy: USER_ID })
    const updatedApp = { ...app, scope: 'personal' as const }

    const findOne = mock(() => Promise.resolve(app))
    const findOneAndUpdate = mock(() => Promise.resolve(updatedApp))
    const collection = mock(() => ({ findOne, findOneAndUpdate }))

    const db = { collection } as unknown as Db
    const { McaService } = await import('../../src/services/mca-service')
    const mcaService = new McaService(db)

    const result = await mcaService.setAppScope('app_test', USER_ID, 'personal')

    expect(result).not.toBeNull()
    expect(result?.scope).toBe('personal')
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1)
  })

  test('setAppScope throws ACCESS_DENIED for anyone but the app owner (MUW-AC-5)', async () => {
    const app = makeApp({ appId: 'app_test', scope: 'shared', installedBy: USER_ID })

    const findOne = mock(() => Promise.resolve(app))
    const findOneAndUpdate = mock(() => Promise.resolve(null))
    const collection = mock(() => ({ findOne, findOneAndUpdate }))

    const db = { collection } as unknown as Db
    const { McaService } = await import('../../src/services/mca-service')
    const mcaService = new McaService(db)

    // A workspace writer/admin who did not install the app: still not the owner.
    await expect(mcaService.setAppScope('app_test', 'user_other', 'personal')).rejects.toThrow('ACCESS_DENIED')
    expect(findOneAndUpdate).not.toHaveBeenCalled()
  })
})
