import { describe, expect, it } from 'bun:test';
import { getAgentId, getFilterContext } from '../../src/lib/context';

function mockContext(overrides: Record<string, any> = {}) {
  return {
    execution: {
      agentId: 'agent-123',
      userId: 'user-456',
      channelId: 'channel-789',
      ...overrides,
    },
  } as any;
}

describe('getAgentId', () => {
  it('returns agentId from execution context', () => {
    const ctx = mockContext();
    expect(getAgentId(ctx)).toBe('agent-123');
  });

  it('throws when agentId is missing', () => {
    const ctx = mockContext({ agentId: undefined });
    expect(() => getAgentId(ctx)).toThrow('agentId is required');
  });

  it('throws when agentId is empty string', () => {
    const ctx = mockContext({ agentId: '' });
    expect(() => getAgentId(ctx)).toThrow('agentId is required');
  });
});

describe('getFilterContext', () => {
  it('returns userId and channelId', () => {
    const ctx = mockContext();
    const result = getFilterContext(ctx);
    expect(result).toEqual({ userId: 'user-456', channelId: 'channel-789' });
  });

  it('returns undefined for missing fields', () => {
    const ctx = mockContext({ userId: undefined, channelId: undefined });
    const result = getFilterContext(ctx);
    expect(result.userId).toBeUndefined();
    expect(result.channelId).toBeUndefined();
  });
});
