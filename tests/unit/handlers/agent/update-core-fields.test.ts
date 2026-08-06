/**
 * agent.update-core must forward EVERY editable engine field to the model
 * service AND surface coreType + defaultApps in its response. The Agent Cores
 * form now edits name/fullName/version/personality/capabilities/defaultApps;
 * a whitelist that drops one of them at the handler boundary would leave the
 * field silently uneditable or invisible (TER-412, the "whitelist forgets a
 * visual field" bug class).
 */
import { describe, expect, it } from 'bun:test';
import { createUpdateCoreHandler } from '../../../../packages/backend/src/handlers/domains/agent/update-core';
import { buildAvatarUrl } from '../../../../packages/backend/src/lib/avatar-url';

function adminDb(): any {
  return {
    collection: (name: string) =>
      name === 'users'
        ? { findOne: async () => ({ userId: 'u', role: 'admin' }) }
        : {},
  };
}

const ctx: any = { userId: 'u' };

describe('agent.update-core field plumbing', () => {
  it('forwards the full updates object verbatim to modelService.updateAgentCore', async () => {
    let received: unknown;
    const modelService: any = {
      updateAgentCore: async (_coreId: string, updates: any) => {
        received = updates;
        return {
          coreId: 'agent',
          coreType: 'agent',
          name: updates.name ?? 'Agent',
          fullName: updates.fullName ?? 'Teros Agent',
          version: updates.version ?? 'v1.0',
          systemPrompt: updates.systemPrompt ?? 'x',
          personality: updates.personality ?? [],
          capabilities: updates.capabilities ?? [],
          defaultApps: updates.defaultApps ?? [],
          avatarUrl: 'a.jpg',
          modelId: updates.modelId ?? 'claude-sonnet-4-5',
          modelOverrides: updates.modelOverrides,
          status: updates.status ?? 'active',
        };
      },
    };
    const handler = createUpdateCoreHandler(adminDb(), modelService);
    const updates = {
      name: 'New',
      fullName: 'New Full',
      version: 'v2.0',
      personality: ['curious'],
      capabilities: ['code'],
      defaultApps: ['mca.teros.core'],
      modelId: 'claude-sonnet-4-5',
      systemPrompt: 'sp',
      modelOverrides: { temperature: 0.5, maxTokens: 4096 },
      status: 'inactive',
    };
    await handler(ctx, { coreId: 'agent', updates });
    expect(received).toEqual(updates);
  });

  it('surfaces the FULL core shape in the response (every field, exact payload)', async () => {
    const core = {
      coreId: 'super-agent-v2',
      coreType: 'super-agent',
      name: 'X',
      fullName: 'XX',
      version: 'v1.0',
      systemPrompt: 'x',
      personality: ['curious'],
      capabilities: ['code'],
      defaultApps: ['mca.teros.core'],
      avatarUrl: 'a.jpg',
      modelId: 'm',
      modelOverrides: { temperature: 0.5 },
      status: 'active',
    };
    const modelService: any = { updateAgentCore: async () => core };
    const handler = createUpdateCoreHandler(adminDb(), modelService);
    const res: any = await handler(ctx, { coreId: 'super-agent-v2', updates: {} });
    // toEqual over the whole object — drop ANY field from the handler's response
    // and this goes red (the "whitelist forgets a visual field" bug class).
    expect(res.core).toEqual({
      coreId: 'super-agent-v2',
      coreType: 'super-agent',
      name: 'X',
      fullName: 'XX',
      version: 'v1.0',
      systemPrompt: 'x',
      personality: ['curious'],
      capabilities: ['code'],
      defaultApps: ['mca.teros.core'],
      avatarUrl: buildAvatarUrl('a.jpg'),
      modelId: 'm',
      modelOverrides: { temperature: 0.5 },
      status: 'active',
    });
  });
});
