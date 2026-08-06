/**
 * TER-157: headless executor + observer chain
 *
 * En el flow start-task (board-runner ejecutando autorun), el sub-canal es
 * `headless: true` (no hay humano suscrito directamente) pero TIENE un
 * `originChannelId` que apunta al chat del manager — un humano sí está
 * suscrito allí. Con dual-broadcast (TER-338), el modal puede surfeacarse
 * en el parent.
 *
 * Verifica:
 *   - headless && !hasObserverChannel → auto-deny inmediato (board sin manager)
 *   - headless && hasObserverChannel → invoca onAskPermission (delega al observer)
 *   - !headless → invoca onAskPermission (flow normal)
 */

import { describe, expect, it, mock } from 'bun:test'
import { McaToolExecutor } from '../../src/services/mca-tool-executor'
import type { McaManager } from '../../src/services/mca-manager'
import type { McaService } from '../../src/services/mca-service'

const AGENT = 'agent_x'
const APP = 'app_fs'
const CHANNEL = 'ch_runner'
const TOOL = 'write-file'

function makeMcaManager(): McaManager {
  return {
    registerApp: mock(async () => undefined),
    executeTool: mock(async () => ({ output: 'ok', isError: false })),
    getMcaIdForTool: mock(() => 'mca.teros.filesystem'),
  } as unknown as McaManager
}

function makeMcaService(): McaService {
  const app = {
    appId: APP,
    mcaId: 'mca.teros.filesystem',
    name: 'fs',
    permissions: { tools: { [TOOL]: 'ask' }, defaultPermission: 'ask' },
  }
  return {
    getAgentApps: mock(async () => ({
      apps: [{ app, permissions: { tools: [{ name: TOOL, permission: 'ask' }] } }],
    })),
    getApp: mock(async () => app),
    hasAccess: mock(async () => true),
    getAgentAppAccess: mock(async () => ({
      appId: APP,
      permissions: { tools: [{ name: TOOL, permission: 'ask' }] },
    })),
  } as unknown as McaService
}

async function buildExecutor(opts: {
  headless: boolean
  hasObserverChannel: boolean
  onAskPermission?: ReturnType<typeof mock>
}) {
  const exec = new McaToolExecutor(makeMcaManager(), makeMcaService(), AGENT, CHANNEL, {
    workspaceId: 'work_x',
    onAskPermission: opts.onAskPermission as any,
  })
  ;(exec as any).initialized = true
  ;(exec as any).toolToAppId = new Map([[TOOL, APP]])
  ;(exec as any).cachedTools = [
    { name: TOOL, description: '', input_schema: { type: 'object', properties: {} } },
  ]
  exec.setUserContext('user_human', 'work_x', 'human', undefined, opts.headless, opts.hasObserverChannel)
  return exec
}

describe('TER-157 — headless executor con observer chain', () => {
  it('headless && NO observer chain → auto-deny sin invocar onAskPermission', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = await buildExecutor({ headless: true, hasObserverChannel: false, onAskPermission: ask })

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_1' })

    expect(result.isError).toBe(true)
    expect(result.permissionDenied).toBe(true)
    expect(result.output).toContain('headless mode with no observer')
    expect(ask).not.toHaveBeenCalled()
  })

  it('headless && observer chain → invoca onAskPermission (delega al observer)', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = await buildExecutor({ headless: true, hasObserverChannel: true, onAskPermission: ask })

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_2' })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toBe(TOOL)
    expect(result.isError).toBe(false)
  })

  it('NO headless → invoca onAskPermission (flow normal)', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = await buildExecutor({ headless: false, hasObserverChannel: false, onAskPermission: ask })

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_3' })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
  })

  it('headless && observer && user deniega → resultado denegado SIN auto-deny ciego', async () => {
    const ask = mock(async () => 'denied' as const)
    const exec = await buildExecutor({ headless: true, hasObserverChannel: true, onAskPermission: ask })

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_4' })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.permissionDenied).toBe(true)
    expect(result.output).toContain('User declined')
  })
})
