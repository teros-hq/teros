/**
 * Direct unit tests for `McaToolExecutor.enforcePermissionPolicy` — the policy
 * gate extracted from `executeTool` (commit `7d21ad32`).
 *
 * Without these, the function was covered only indirectly by tests that call
 * `executeTool`. If someone refactors `enforcePermissionPolicy` without touching
 * `executeTool`, indirect tests may keep passing while the gate is broken. These
 * tests pin the contract: each of the 4 paths returns the expected shape.
 *
 * Pattern:
 *   - Build a minimal McaToolExecutor with mocked McaManager + McaService.
 *   - Skip `initialize()` by manually populating `cachedTools` + `toolToAppId`.
 *   - Call `enforcePermissionPolicy` directly via `(exec as any)`.
 */

import { describe, expect, it, mock } from 'bun:test'
import { McaToolExecutor } from '../../src/services/mca-tool-executor'
import type { McaManager } from '../../src/services/mca-manager'
import type { McaService } from '../../src/services/mca-service'

const AGENT = 'agent_test'
const CHANNEL = 'ch_test'
const APP = 'app_fs'
const TOOL = 'write-file'

function makeMcaManager(): McaManager {
  return {
    registerApp: mock(async () => undefined),
    executeTool: mock(async () => ({ output: 'ok', isError: false })),
    getMcaIdForTool: mock(() => 'mca.teros.filesystem'),
  } as unknown as McaManager
}

function makeMcaService(opts: {
  permission?: 'allow' | 'ask' | 'forbid'
  hasAccessResult?: boolean
} = {}): McaService {
  const permission = opts.permission ?? 'ask'
  const app = {
    appId: APP,
    mcaId: 'mca.teros.filesystem',
    name: 'fs',
    permissions: { tools: { [TOOL]: permission }, defaultPermission: permission },
  }
  return {
    getAgentApps: mock(async () => ({
      apps: [{ app, permissions: { tools: [{ name: TOOL, permission }] } }],
    })),
    getApp: mock(async () => app),
    hasAccess: mock(async () => opts.hasAccessResult ?? true),
    getAgentAppAccess: mock(async () => ({
      appId: APP,
      permissions: { tools: [{ name: TOOL, permission }] },
    })),
  } as unknown as McaService
}

function buildExecutor(opts: {
  permission?: 'allow' | 'ask' | 'forbid'
  hasAccessResult?: boolean
  onAskPermission?: ReturnType<typeof mock>
  headless?: boolean
  hasObserverChannel?: boolean
  toolInCache?: boolean
}) {
  const exec = new McaToolExecutor(makeMcaManager(), makeMcaService(opts), AGENT, CHANNEL, {
    workspaceId: 'work_test',
    onAskPermission: opts.onAskPermission as any,
  })
  ;(exec as any).initialized = true
  if (opts.toolInCache !== false) {
    ;(exec as any).toolToAppId = new Map([[TOOL, APP]])
    ;(exec as any).cachedTools = [
      { name: TOOL, description: '', input_schema: { type: 'object', properties: {} } },
    ]
  } else {
    ;(exec as any).toolToAppId = new Map()
    ;(exec as any).cachedTools = []
  }
  exec.setUserContext(
    'user_human',
    'work_test',
    'human',
    undefined,
    opts.headless ?? false,
    opts.hasObserverChannel ?? false,
  )
  return exec
}

async function runPolicy(
  exec: McaToolExecutor,
  input: Record<string, any> = {},
  options: Record<string, any> = {},
) {
  return (exec as any).enforcePermissionPolicy(TOOL, input, { toolCallId: 'tc_x', ...options })
}

describe('enforcePermissionPolicy — direct unit tests', () => {
  it('FORBID path: tool with permission=forbid returns error result without invoking onAskPermission', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({ permission: 'forbid', onAskPermission: ask })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.permissionDenied).toBe(true)
    expect(r.result.output).toContain('not allowed')
    expect(ask).not.toHaveBeenCalled()
  })

  it('FORBID path: tool that does not exist (no appId) returns "does not exist" without permissionDenied flag', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({ onAskPermission: ask, toolInCache: false })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.permissionDenied).toBeFalsy()
    expect(r.result.output).toContain('does not exist')
  })

  it('ASK granted: onAskPermission returns granted → result undefined, permCheck.appId set, caller continues to execute', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({ permission: 'ask', onAskPermission: ask })

    const r = await runPolicy(exec)

    expect(r.result).toBeUndefined()
    expect(r.permCheck.appId).toBe(APP)
    expect(r.permCheck.permission).toBe('ask')
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('ASK granted but signal already aborted: returns cancellation error instead of proceeding', async () => {
    // The permission wait can outlive the dispatch (turn interrupted while the
    // user decided). Executing anyway would be cut at the transport layer with
    // a generic cancellation — the gate must fail fast with a clear message.
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({ permission: 'ask', onAskPermission: ask })
    const ac = new AbortController()
    ac.abort()

    const r = await runPolicy(exec, {}, { signal: ac.signal })

    expect(ask).toHaveBeenCalledTimes(1)
    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.output).toContain('interrupted while waiting for approval')
  })

  it('ASK granted with a live (non-aborted) signal: caller continues to execute', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({ permission: 'ask', onAskPermission: ask })

    const r = await runPolicy(exec, {}, { signal: new AbortController().signal })

    expect(r.result).toBeUndefined()
    expect(r.permCheck.appId).toBe(APP)
  })

  it('ASK denied: onAskPermission returns denied → result error with permissionDenied flag', async () => {
    const ask = mock(async () => 'denied' as const)
    const exec = buildExecutor({ permission: 'ask', onAskPermission: ask })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.permissionDenied).toBe(true)
    expect(r.result.output).toContain('User declined')
  })

  it('ASK without callback: tool requires confirmation → result returns permission_required signal', async () => {
    const exec = buildExecutor({ permission: 'ask' /* no onAskPermission */ })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(false)
    expect(r.result.permissionRequired).toBe(true)
    const payload = JSON.parse(r.result.output)
    expect(payload.type).toBe('permission_required')
    expect(payload.appId).toBe(APP)
  })

  it('HEADLESS without observer: ask → auto-deny with "no observer" message (TER-157)', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({
      permission: 'ask',
      onAskPermission: ask,
      headless: true,
      hasObserverChannel: false,
    })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.permissionDenied).toBe(true)
    expect(r.result.output).toContain('headless mode with no observer')
    expect(ask).not.toHaveBeenCalled()
  })

  it('HEADLESS with observer: ask → falls through to onAskPermission (TER-157 + TER-338)', async () => {
    const ask = mock(async () => 'granted' as const)
    const exec = buildExecutor({
      permission: 'ask',
      onAskPermission: ask,
      headless: true,
      hasObserverChannel: true,
    })

    const r = await runPolicy(exec)

    expect(r.result).toBeUndefined()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(r.permCheck.appId).toBe(APP)
  })

  it('ALLOW path: permission=allow → result undefined, caller continues to execute', async () => {
    const exec = buildExecutor({ permission: 'allow' })

    const r = await runPolicy(exec)

    expect(r.result).toBeUndefined()
    expect(r.permCheck.permission).toBe('allow')
    expect(r.permCheck.appId).toBe(APP)
  })

  it('ACCESS REVOKED: hasAccess returns false after permission check → result error with "revoked" message', async () => {
    const exec = buildExecutor({ permission: 'allow', hasAccessResult: false })

    const r = await runPolicy(exec)

    expect(r.result).toBeDefined()
    expect(r.result.isError).toBe(true)
    expect(r.result.permissionDenied).toBe(true)
    expect(r.result.output).toContain('revoked')
  })
})
