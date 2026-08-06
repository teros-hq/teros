/**
 * Cores are internal: the agent.update-core and agent.list-cores actions must
 * reject non-admin callers (closes the pre-existing permission hole).
 */
import { describe, expect, it } from 'bun:test';
import { createUpdateCoreHandler } from '../../../../packages/backend/src/handlers/domains/agent/update-core';
import { createListCoresHandler } from '../../../../packages/backend/src/handlers/domains/agent/list-cores';

function dbWithRole(role: string): any {
  return {
    collection: (name: string) => {
      if (name === 'users') {
        return { findOne: async () => ({ userId: 'u', role }) };
      }
      return {};
    },
  };
}

const modelServiceMock: any = {
  updateAgentCore: async () => ({
    coreId: 'agent',
    coreType: 'agent',
    name: 'Agent',
    fullName: 'Teros Agent',
    version: 'v1.0',
    systemPrompt: 'x',
    personality: [],
    capabilities: [],
    defaultApps: [],
    avatarUrl: 'a.jpg',
    modelId: 'claude-sonnet-4-5',
    modelOverrides: {},
    status: 'active',
  }),
  listAgentCores: async () => [],
};

const ctx: any = { userId: 'u' };

describe('agent.update-core admin gate', () => {
  it('rejects non-admin users', async () => {
    const handler = createUpdateCoreHandler(dbWithRole('user'), modelServiceMock);
    await expect(handler(ctx, { coreId: 'agent', updates: {} })).rejects.toThrow(/admin/i);
  });

  it('allows admins', async () => {
    const handler = createUpdateCoreHandler(dbWithRole('admin'), modelServiceMock);
    const res = await handler(ctx, { coreId: 'agent', updates: {} });
    expect((res as any).core.coreId).toBe('agent');
  });
});

describe('agent.list-cores admin gate', () => {
  it('rejects non-admin users', async () => {
    const handler = createListCoresHandler(dbWithRole('user'), modelServiceMock);
    await expect(handler(ctx, {})).rejects.toThrow(/admin/i);
  });

  it('allows admins', async () => {
    const handler = createListCoresHandler(dbWithRole('super'), modelServiceMock);
    const res = await handler(ctx, {});
    expect(Array.isArray((res as any).cores)).toBe(true);
  });
});
