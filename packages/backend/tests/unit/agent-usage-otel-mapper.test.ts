import { describe, expect, it } from 'bun:test'
import { toOtelGenAI } from '../../src/services/agent-usage-otel-mapper'
import type { AgentUsageSession } from '../../src/types/database'

function makeSession(overrides: Partial<AgentUsageSession> = {}): AgentUsageSession {
  return {
    sessionUsageId: 'usess_abc',
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    actualModel: 'claude-sonnet-4-5-20250929',
    startedAt: new Date('2026-05-19T10:00:00Z'),
    endedAt: new Date('2026-05-19T10:00:12Z'),
    durationMs: 12000,
    durationSource: 'monotonic',
    status: 'completed',
    inputTokens: 1200,
    outputTokens: 340,
    cachedReadTokens: 100,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1540,
    costUsd: 0.012,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('toOtelGenAI', () => {
  it('emits the OTel GenAI required attributes', () => {
    const out = toOtelGenAI(makeSession())
    expect(out['gen_ai.operation.name']).toBe('agent.session')
    expect(out['gen_ai.system']).toBe('anthropic')
    expect(out['gen_ai.request.model']).toBe('claude-sonnet-4-5')
    expect(out['gen_ai.response.model']).toBe('claude-sonnet-4-5-20250929')
    expect(out['gen_ai.usage.input_tokens']).toBe(1200)
    expect(out['gen_ai.usage.output_tokens']).toBe(340)
    expect(out['gen_ai.conversation.id']).toBe('ch_1')
    expect(out['gen_ai.agent.id']).toBe('agent_1')
  })

  it('collapses anthropic-oauth → anthropic', () => {
    const out = toOtelGenAI(makeSession({ provider: 'anthropic-oauth' }))
    expect(out['gen_ai.system']).toBe('anthropic')
  })

  it('collapses ollama-cloud → ollama', () => {
    const out = toOtelGenAI(makeSession({ provider: 'ollama-cloud' }))
    expect(out['gen_ai.system']).toBe('ollama')
  })

  it('falls back to actualModel === modelId when actualModel is null', () => {
    const out = toOtelGenAI(makeSession({ actualModel: undefined }))
    expect(out['gen_ai.response.model']).toBe('claude-sonnet-4-5')
  })

  it('exposes teros custom attributes', () => {
    const out = toOtelGenAI(makeSession({ parentSessionUsageId: 'usess_parent' }))
    expect(out['teros.usage.session_id']).toBe('usess_abc')
    expect(out['teros.usage.parent_session_id']).toBe('usess_parent')
    expect(out['teros.usage.trigger_kind']).toBe('user_message')
    expect(out['teros.usage.duration_ms']).toBe(12000)
    expect(out['teros.usage.cost_usd']).toBe(0.012)
  })
})
