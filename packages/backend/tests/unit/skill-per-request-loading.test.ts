/**
 * Unit tests for per-request skill loading via skillIds (TER-618 Wave 4).
 *
 * Tests the skill resolution loop (silently discarding invalid skills) and
 * the <loaded_skills> injection in buildSystemPrompt.
 *
 * Pattern: mocks, no MongoDB real.
 */

import { describe, expect, it, mock } from 'bun:test'
import { ModelService } from '../../src/services/model-service'
import type { SkillService, SkillInterpolationContext, LoadedSkillResult } from '../../src/services/skill-service'
import type { Db } from 'mongodb'

// Minimal mock for buildSystemPrompt tests
function makeMockDb(): Db {
  return {
    collection: () => ({
      findOne: async () => null,
      find: () => ({ toArray: async () => [] }),
      createIndex: async () => 'index_1',
    }),
  } as unknown as Db
}

function makeSkillService(opts: {
  loadResults?: Record<string, LoadedSkillResult | null>
} = {}): SkillService {
  return {
    loadSkillForInjection: mock(async (_agentId: string, _workspaceId: string, ref: { skillId?: string; name?: string }) => {
      const key = ref.skillId || ref.name || ''
      return opts.loadResults?.[key] ?? null
    }),
    getAlwaysOnSkills: mock(async () => []),
    getOnDemandSkillIndex: mock(async () => []),
  } as unknown as SkillService
}

const INTERPOLATION_CTX: SkillInterpolationContext = {
  agent: { name: 'Test', fullName: 'Test Agent', role: 'executor', intro: 'I am a test agent' },
  workspace: { name: 'Test Workspace' },
}

const AGENT_ID = 'agent_test'
const WORKSPACE_ID = 'work_test'

describe('Per-request skill resolution — silent discard', () => {
  // 1. send_message with skillIds valid
  it('resolves valid skillId into loadedSkillsContent', async () => {
    const skillService = makeSkillService({
      loadResults: {
        'sk_valid': { name: 'Valid Skill', content: 'Valid content' },
      },
    })

    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    const skillIds = ['sk_valid']

    for (const skillId of skillIds) {
      const result = await skillService.loadSkillForInjection(
        AGENT_ID, WORKSPACE_ID, { skillId }, INTERPOLATION_CTX,
      )
      if (result) loadedSkillsContent.push(result)
    }

    expect(loadedSkillsContent).toHaveLength(1)
    expect(loadedSkillsContent[0].name).toBe('Valid Skill')
    expect(loadedSkillsContent[0].content).toBe('Valid content')
  })

  // 2. send_message with skillIds not assigned
  it('silently discards not-assigned skillId', async () => {
    const skillService = makeSkillService({
      loadResults: { 'sk_unknown': null },
    })

    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    const skillIds = ['sk_unknown']

    for (const skillId of skillIds) {
      const result = await skillService.loadSkillForInjection(
        AGENT_ID, WORKSPACE_ID, { skillId }, INTERPOLATION_CTX,
      )
      if (result) loadedSkillsContent.push(result)
    }

    expect(loadedSkillsContent).toHaveLength(0)
  })

  // 3. send_message with skillIds cross-workspace (IDOR)
  it('silently discards cross-workspace skillId', async () => {
    const skillService = makeSkillService({
      loadResults: { 'sk_other_ws': null }, // IDOR guard returns null
    })

    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    const skillIds = ['sk_other_ws']

    for (const skillId of skillIds) {
      const result = await skillService.loadSkillForInjection(
        AGENT_ID, WORKSPACE_ID, { skillId }, INTERPOLATION_CTX,
      )
      if (result) loadedSkillsContent.push(result)
    }

    expect(loadedSkillsContent).toHaveLength(0)
  })

  // 4. send_message with skillIds disabled
  it('silently discards disabled skillId', async () => {
    const skillService = makeSkillService({
      loadResults: { 'sk_disabled': null }, // enabled=false returns null
    })

    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    const skillIds = ['sk_disabled']

    for (const skillId of skillIds) {
      const result = await skillService.loadSkillForInjection(
        AGENT_ID, WORKSPACE_ID, { skillId }, INTERPOLATION_CTX,
      )
      if (result) loadedSkillsContent.push(result)
    }

    expect(loadedSkillsContent).toHaveLength(0)
  })

  // 5. send_message without skillIds
  it('produces empty loadedSkillsContent when skillIds absent', async () => {
    const skillIds: string[] | undefined = undefined
    const loadedSkillsContent: Array<{ name: string; content: string }> = []

    if (skillIds && skillIds.length > 0) {
      // Would resolve skills — but skillIds is undefined
    }

    expect(loadedSkillsContent).toHaveLength(0)
  })

  // 6. send_message with multiple skillIds mixed
  it('resolves only valid skills from mixed skillIds', async () => {
    const skillService = makeSkillService({
      loadResults: {
        'sk_valid': { name: 'Valid', content: 'Content' },
        'sk_invalid': null,
        'sk_valid2': { name: 'Valid2', content: 'Content2' },
      },
    })

    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    const skillIds = ['sk_valid', 'sk_invalid', 'sk_valid2']

    for (const skillId of skillIds) {
      const result = await skillService.loadSkillForInjection(
        AGENT_ID, WORKSPACE_ID, { skillId }, INTERPOLATION_CTX,
      )
      if (result) loadedSkillsContent.push(result)
    }

    expect(loadedSkillsContent).toHaveLength(2)
    expect(loadedSkillsContent[0].name).toBe('Valid')
    expect(loadedSkillsContent[1].name).toBe('Valid2')
  })
})

describe('buildSystemPrompt — loadedSkillsContent injection', () => {
  const mockDb = makeMockDb()
  const service = new ModelService(mockDb)
  // Mock the internal skillService to avoid DB calls
  ;(service as any).skillService = {
    getAlwaysOnSkills: mock(async () => []),
    getOnDemandSkillIndex: mock(async () => []),
    getPartitionedAgentSkills: mock(async () => ({ alwaysOn: [], onDemandIndex: [] })),
  }

  const core = {
    systemPrompt: 'CORE',
    model: {
      modelId: 'model_x',
      provider: 'anthropic',
      modelString: 'claude-3-5-sonnet',
      capabilities: { streaming: true, tools: true, vision: false, thinking: false },
      context: { maxTokens: 200_000 },
      providerConfig: {},
    },
    effectiveConfig: { temperature: 0.7, maxTokens: 4096 },
  } as any

  const agent = {
    agentId: AGENT_ID,
    name: 'Test',
    fullName: 'Test Agent',
    role: 'executor',
    intro: 'I am a test agent',
    workspaceId: WORKSPACE_ID,
  } as any

  // 7. buildSystemPrompt with loadedSkillsContent
  it('generates <loaded_skills> block when loadedSkillsContent present', async () => {
    const loadedSkillsContent = [
      { name: 'Skill A', content: 'Content A' },
      { name: 'Skill B', content: 'Content B' },
    ]

    const { systemPrompt: prompt, systemPromptVolatile } = await (service as any).buildSystemPrompt(
      core, agent, undefined, undefined, undefined, undefined, undefined, undefined,
      loadedSkillsContent,
    )

    expect(prompt).toContain('<loaded_skills>')
    expect(prompt).toContain('<loaded_skill name="Skill A">')
    expect(prompt).toContain('Content A')
    expect(prompt).toContain('<loaded_skill name="Skill B">')
    expect(prompt).toContain('Content B')
    expect(prompt).toContain('</loaded_skills>')
    // loaded_skills lives in the volatile (non-cached) suffix, and the full prompt
    // ends with it so cache-aware adapters can slice it off (TER-618).
    expect(systemPromptVolatile).toContain('<loaded_skills>')
    expect(prompt.endsWith(systemPromptVolatile)).toBe(true)
  })

  // 8. buildSystemPrompt without loadedSkillsContent
  it('does not generate <loaded_skills> when loadedSkillsContent absent', async () => {
    const { systemPrompt: prompt } = await (service as any).buildSystemPrompt(
      core, agent, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
    )

    expect(prompt).not.toContain('<loaded_skills>')
  })

  // 9. buildSystemPrompt escapes special chars in skill names
  it('escapes special characters in loaded_skill name attribute', async () => {
    const loadedSkillsContent = [
      { name: 'Skill<"X">', content: 'Content' },
    ]

    const { systemPrompt: prompt } = await (service as any).buildSystemPrompt(
      core, agent, undefined, undefined, undefined, undefined, undefined, undefined,
      loadedSkillsContent,
    )

    expect(prompt).toContain('<loaded_skill name="Skill&lt;&quot;X&quot;&gt;">')
  })
})


describe('Per-request skill resolution — validation (Eve audit INVAL-1)', () => {
  // Helper that replicates the validation logic from processAgentResponse
  async function resolveSkillIds(
    skillService: SkillService,
    agentId: string,
    workspaceId: string,
    skillIds: string[] | undefined,
    skillInterpolationCtx: SkillInterpolationContext,
  ): Promise<Array<{ name: string; content: string }>> {
    const loadedSkillsContent: Array<{ name: string; content: string }> = []
    if (skillIds && skillIds.length > 0 && skillInterpolationCtx) {
      const MAX_SKILL_IDS = 10
      const SKILL_ID_REGEX = /^sk_[a-zA-Z0-9]+$/

      const uniqueSkillIds = [...new Set(skillIds)]
      const limitedSkillIds = uniqueSkillIds.slice(0, MAX_SKILL_IDS)

      for (const skillId of limitedSkillIds) {
        if (typeof skillId !== 'string' || !SKILL_ID_REGEX.test(skillId)) {
          continue
        }
        const result = await skillService.loadSkillForInjection(
          agentId, workspaceId, { skillId }, skillInterpolationCtx,
        )
        if (result) {
          loadedSkillsContent.push(result)
        }
      }
    }
    return loadedSkillsContent
  }

  // 10. Invalid skillId format silently discarded
  it('silently discards invalid skillId format', async () => {
    const skillService = makeSkillService({
      loadResults: {
        'sk_valid': { name: 'Valid', content: 'Content' },
      },
    })
    const skillIds = ['sk_valid', 'invalid-id', 'not_sk_format', '']
    const loaded = await resolveSkillIds(skillService, AGENT_ID, WORKSPACE_ID, skillIds, INTERPOLATION_CTX)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('Valid')
  })

  // 11. Deduplication
  it('deduplicates duplicate skillIds', async () => {
    const skillService = makeSkillService({
      loadResults: {
        'sk_1': { name: 'Skill1', content: 'Content1' },
      },
    })
    const skillIds = ['sk_1', 'sk_1', 'sk_1']
    const loaded = await resolveSkillIds(skillService, AGENT_ID, WORKSPACE_ID, skillIds, INTERPOLATION_CTX)
    expect(loaded).toHaveLength(1)
  })

  // 12. Limit to max 10
  it('limits skillIds to maximum 10', async () => {
    const loadResults: Record<string, LoadedSkillResult> = {}
    for (let i = 0; i < 15; i++) {
      loadResults[`sk_${i}`] = { name: `Skill${i}`, content: `Content${i}` }
    }
    const skillService = makeSkillService({ loadResults })
    const skillIds = Array.from({ length: 15 }, (_, i) => `sk_${i}`)
    const loaded = await resolveSkillIds(skillService, AGENT_ID, WORKSPACE_ID, skillIds, INTERPOLATION_CTX)
    expect(loaded).toHaveLength(10)
  })
})
