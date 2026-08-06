import { describe, expect, it } from 'bun:test'
import { AgentRollupGroupKey } from '../../src/services/agent-rollup-group-key'
import type { AgentUsageSession } from '../../src/types/database'

function makeSession(overrides: Partial<AgentUsageSession> = {}): AgentUsageSession {
  return {
    sessionUsageId: 'usess_x',
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    startedAt: new Date(),
    endedAt: null,
    durationMs: null,
    durationSource: null,
    status: 'running',
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 0,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('AgentRollupGroupKey', () => {
  it('toString is deterministic for the same inputs', () => {
    const k1 = AgentRollupGroupKey.fromSession(makeSession())
    const k2 = AgentRollupGroupKey.fromSession(makeSession())
    expect(k1.toString()).toBe(k2.toString())
  })

  it('toString includes all four dimensions separated by pipes', () => {
    const k = AgentRollupGroupKey.fromSession(makeSession())
    expect(k.toString()).toBe('user_1|agent_1|anthropic|work_1')
  })

  it('different dimensions produce different keys', () => {
    const a = AgentRollupGroupKey.fromSession(makeSession({ userId: 'user_a' }))
    const b = AgentRollupGroupKey.fromSession(makeSession({ userId: 'user_b' }))
    expect(a.toString()).not.toBe(b.toString())
  })

  it('equals compares all four dimensions', () => {
    const a = AgentRollupGroupKey.fromSession(makeSession())
    const b = AgentRollupGroupKey.fromSession(makeSession())
    const c = AgentRollupGroupKey.fromSession(makeSession({ agentId: 'agent_other' }))
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(false)
  })

  it('fromGroupKey round-trips with toGroupKey', () => {
    const original = AgentRollupGroupKey.fromSession(makeSession())
    const gk = original.toGroupKey()
    const restored = AgentRollupGroupKey.fromGroupKey(gk)
    expect(restored.equals(original)).toBe(true)
  })

  it('toGroupKey returns a plain object compatible with AgentUsageRollupHourly.groupKey', () => {
    const k = AgentRollupGroupKey.fromSession(makeSession())
    const gk = k.toGroupKey()
    expect(gk).toEqual({
      userId: 'user_1',
      agentId: 'agent_1',
      provider: 'anthropic',
      workspaceId: 'work_1',
    })
  })
})
