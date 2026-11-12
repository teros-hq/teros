/**
 * Headless auto-denial text (docs/specs/todo/autoplay/spec.md, TODOAP-REQ-23).
 *
 * Same construction as headless-observer-chain.test.ts: a headless executor
 * with no observer channel and one 'ask' tool. With the To Do app among the
 * agent's tools the denial tells the agent to block the task with the
 * permission it needs; without it the progress-note text stays.
 */

import { describe, expect, it, mock } from 'bun:test'
import { McaToolExecutor } from '../../src/services/mca-tool-executor'
import type { McaManager } from '../../src/services/mca-manager'
import type { McaService } from '../../src/services/mca-service'

const AGENT = 'agent_x'
const APP = 'app_todo'
const CHANNEL = 'ch_todo'
const TOOL = 'todo-list_assign-node'

function makeMcaManager(): McaManager {
  return {
    registerApp: mock(async () => undefined),
    executeTool: mock(async () => ({ output: 'ok', isError: false })),
    getMcaIdForTool: mock(() => 'mca.teros.todo-list'),
  } as unknown as McaManager
}

function makeMcaService(): McaService {
  const app = {
    appId: APP,
    mcaId: 'mca.teros.todo-list',
    name: 'todo-list',
    permissions: { tools: { [TOOL]: 'ask' }, defaultPermission: 'ask' },
  }
  return {
    // MUW-REQ-12: no conversation viewer in these fixtures → the legacy per-agent app set
    getChannelViewer: mock(async () => null),
    isAppUsableBy: () => true,
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

function buildExecutor(toolNames: string[]) {
  const exec = new McaToolExecutor(makeMcaManager(), makeMcaService(), AGENT, CHANNEL, {
    workspaceId: 'work_x',
  })
  ;(exec as any).initialized = true
  ;(exec as any).toolToAppId = new Map(toolNames.map((n) => [n, APP]))
  ;(exec as any).cachedTools = toolNames.map((name) => ({
    name,
    description: '',
    input_schema: { type: 'object', properties: {} },
  }))
  exec.setUserContext('user_human', 'work_x', 'human', undefined, true, false)
  return exec
}

describe('headless auto-denial (TODOAP-REQ-23)', () => {
  it('[TODOAP-AC-34] with the To Do tools the denial says to block with the permission needed, not review', async () => {
    const exec = buildExecutor([TOOL, 'todo-list_set-state'])

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_1' })

    expect(result.isError).toBe(true)
    expect(result.permissionDenied).toBe(true)
    expect(result.output).toStartWith(
      `Permission denied: Tool '${TOOL}' requires user approval, but this conversation is running in headless mode with no observer channel`,
    )
    expect(result.output).toContain('`todo-list_set-state`')
    expect(result.output).toContain('`blocked`')
    expect(result.output).toContain(`Permission needed: ${TOOL} — <what you needed it for>`)
    expect(result.output).toContain('Do not send the task to review.')
    expect(result.output).not.toContain('progress note')
  })

  it('[TODOAP-AC-34] without the To Do tools the denial keeps the progress-note text', async () => {
    const exec = buildExecutor([TOOL])

    const result = await exec.executeTool(TOOL, {}, { toolCallId: 'tc_2' })

    expect(result.isError).toBe(true)
    expect(result.permissionDenied).toBe(true)
    expect(result.output).toBe(
      `Permission denied: Tool '${TOOL}' requires user approval, but this conversation is running in headless mode with no observer channel (no user is available to approve). The action has been automatically denied. You may add a progress note indicating that this permission is needed so it can be resolved manually.`,
    )
  })
})
