/**
 * Unit tests for McaToolExecutor native `load_skill` tool (TER-618 Wave 3).
 *
 * Pattern: real McaToolExecutor over mocked McaManager + McaService + SkillService.
 * initialize() is called for tests that need the tool cache, or skipped by
 * manually populating `cachedTools`/`toolToAppId` for direct executeTool tests.
 */

import { describe, expect, it, mock } from 'bun:test'
import { McaToolExecutor } from '../../src/services/mca-tool-executor'
import type { McaManager } from '../../src/services/mca-manager'
import type { McaService } from '../../src/services/mca-service'
import type { SkillService, SkillInterpolationContext, LoadedSkillResult } from '../../src/services/skill-service'

const AGENT = 'agent_test'
const CHANNEL = 'ch_test'
const WORKSPACE = 'work_test'

function makeMcaManager(): McaManager {
  return {
    registerApp: mock(async () => undefined),
    executeTool: mock(async () => ({ output: 'ok', isError: false })),
    getMcaIdForTool: mock(() => 'mca.test'),
  } as unknown as McaManager
}

function makeMcaService(): McaService {
  return {
    // MUW-REQ-12: no conversation viewer in these fixtures → the legacy per-agent app set
    getChannelViewer: mock(async () => null),
    isAppUsableBy: () => true,
    getAgentApps: mock(async () => ({ apps: [] })),
    getApp: mock(async () => null),
    hasAccess: mock(async () => true),
    getAgentAppAccess: mock(async () => null),
  } as unknown as McaService
}

function makeSkillService(opts: {
  onDemandIndex?: Array<{ skillId: string; name: string; description?: string }>
  loadResult?: LoadedSkillResult | null
} = {}): SkillService {
  return {
    getOnDemandSkillIndex: mock(async () => opts.onDemandIndex ?? []),
    loadSkillForInjection: mock(async () => opts.loadResult ?? null),
  } as unknown as SkillService
}

function makeSkillInterpolationCtx(): SkillInterpolationContext {
  return {
    agent: { name: 'Test', fullName: 'Test Agent', role: 'executor', intro: 'I am a test agent' },
    workspace: { name: 'Test Workspace' },
  }
}

function buildExecutor(opts: {
  skillService?: SkillService
  skillInterpolationCtx?: SkillInterpolationContext
  workspaceId?: string
  initialized?: boolean
} = {}) {
  const exec = new McaToolExecutor(makeMcaManager(), makeMcaService(), AGENT, CHANNEL, {
    workspaceId: opts.workspaceId ?? WORKSPACE,
    skillService: opts.skillService,
    skillInterpolationCtx: opts.skillInterpolationCtx,
  })
  ;(exec as any).initialized = opts.initialized !== false
  return exec
}

describe('McaToolExecutor — load_skill native tool', () => {
  // 1. getTools includes load_skill when on-demand skills exist
  it('getTools includes load_skill when on-demand skills exist', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill', description: 'A test skill' }],
    })
    const exec = buildExecutor({ skillService, initialized: false })
    await exec.initialize()
    const tools = exec.getTools()
    expect(tools.some((t: any) => t.name === 'load_skill')).toBe(true)
  })

  // 2. getTools excludes load_skill when no on-demand skills
  it('getTools excludes load_skill when no on-demand skills', async () => {
    const skillService = makeSkillService({ onDemandIndex: [] })
    const exec = buildExecutor({ skillService, initialized: false })
    await exec.initialize()
    const tools = exec.getTools()
    expect(tools.some((t: any) => t.name === 'load_skill')).toBe(false)
  })

  // 3. executeTool load_skill success
  it('executeTool load_skill success', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
      loadResult: { name: 'test-skill', content: 'Skill content here' },
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<loaded_skill name="test-skill">')
    expect(result.output).toContain('Skill content here')
    expect(result.output).toContain('</loaded_skill>')
  })

  // 3b. executeTool load_skill success with special chars in name (escapePromptBlockAttr)
  it('executeTool load_skill success with special chars in name', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test<skill>"quotes"' }],
      loadResult: { name: 'test<skill>"quotes"', content: 'Content with special chars' },
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test<skill>"quotes"' })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('<loaded_skill name="test&lt;skill&gt;&quot;quotes&quot;">')
    expect(result.output).toContain('Content with special chars')
  })

  // 4. executeTool load_skill not found
  it('executeTool load_skill not found', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
      loadResult: null,
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'unknown-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("not found")
  })

  // 5. executeTool load_skill no skillService
  it('executeTool load_skill no skillService', async () => {
    const exec = buildExecutor({ skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available in this context')
  })

  // 5b. executeTool load_skill no skillInterpolationCtx
  it('executeTool load_skill no skillInterpolationCtx', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: undefined })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available in this context')
  })

  // 6. hasTool load_skill
  it('hasTool load_skill', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
    })
    const exec = buildExecutor({ skillService, initialized: false })
    await exec.initialize()
    expect(exec.hasTool('load_skill')).toBe(true)
  })

  // 7. checkToolPermission load_skill
  it('checkToolPermission load_skill', async () => {
    const exec = buildExecutor()
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.checkToolPermission('load_skill')

    expect(result.allowed).toBe(true)
    expect(result.permission).toBe('allow')
  })

  // 8. executeTool load_skill cross-workspace (IDOR) — loadSkillForInjection returns null
  it('executeTool load_skill cross-workspace', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
      loadResult: null, // Simulates IDOR guard in SkillService returning null
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("not found")
  })

  // 9. executeTool load_skill disabled
  it('executeTool load_skill disabled', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
      loadResult: null, // Simulates disabled skill (access entry has enabled=false)
    })
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain("not found")
  })

  // 10. executeTool load_skill no workspaceId
  it('executeTool load_skill no workspaceId', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
    })
    const exec = new McaToolExecutor(makeMcaManager(), makeMcaService(), AGENT, CHANNEL, {
      workspaceId: undefined,
      skillService,
      skillInterpolationCtx: makeSkillInterpolationCtx(),
    })
    ;(exec as any).initialized = true
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 'test-skill' })

    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available in this context')
  })

  // 11. executeTool load_skill invalid input — empty
  it('executeTool load_skill invalid input — empty', async () => {
    const skillService = makeSkillService()
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('requires a non-empty')
  })

  // 11b. executeTool load_skill invalid input — whitespace-only
  it('executeTool load_skill invalid input — whitespace-only', async () => {
    const skillService = makeSkillService()
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: '   ' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('requires a non-empty')
  })

  // 11c. executeTool load_skill invalid input — non-string
  it('executeTool load_skill invalid input — non-string', async () => {
    const skillService = makeSkillService()
    const exec = buildExecutor({ skillService, skillInterpolationCtx: makeSkillInterpolationCtx() })
    ;(exec as any).cachedTools = [{ name: 'load_skill', description: 'Load a skill', input_schema: {} }]
    ;(exec as any).toolToAppId = new Map([['load_skill', '__native__']])

    const result = await exec.executeTool('load_skill', { name: 123 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('requires a non-empty')
  })

  // 12. refresh() must NOT drop load_skill (regression: PR #375 #3)
  it('refresh() preserves load_skill when on-demand skills exist', async () => {
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
    })
    const exec = buildExecutor({ skillService, initialized: false })
    await exec.initialize()
    expect(exec.hasTool('load_skill')).toBe(true)

    // A mid-conversation refresh rebuilds the tool cache; load_skill must survive.
    await exec.refresh()
    expect(exec.hasTool('load_skill')).toBe(true)
  })

  // 13. setSkillContext wires load_skill onto an executor built without a service
  //     (regression: PR #375 #2 — cached executor reuse)
  it('setSkillContext registers load_skill on a skill-less executor', async () => {
    // Executor initialized with NO skill service (e.g. restored-tool path).
    const exec = buildExecutor({ skillService: undefined, initialized: false })
    await exec.initialize()
    expect(exec.hasTool('load_skill')).toBe(false)

    // Later LLM turn wires the skill service onto the cached executor.
    const skillService = makeSkillService({
      onDemandIndex: [{ skillId: 'sk_1', name: 'test-skill' }],
    })
    await exec.setSkillContext(skillService, makeSkillInterpolationCtx())
    expect(exec.hasTool('load_skill')).toBe(true)
  })
})

describe('McaToolExecutor — getToolCallContext (PERMW-REQ-2)', () => {
  it('[PERMW-AC-2] the tracked tool call context carries the mcaId of its tool', () => {
    const exec = buildExecutor()
    exec.trackToolCall('tc_1', 'msg_1', 'hubspot_create-contact')
    expect(exec.getToolCallContext('tc_1')).toEqual({
      messageId: 'msg_1',
      toolCallId: 'tc_1',
      toolName: 'hubspot_create-contact',
      mcaId: 'mca.test',
    })
    expect(exec.getToolCallContext('tc_unknown')).toBeNull()
  })
})
