/**
 * Tests for AgentProvisioningService — core assignment is internal and derived
 * from the agent's scope (the user never picks a core).
 */
import { describe, expect, it } from 'bun:test';
import { AgentProvisioningService } from '../../../packages/backend/src/services/agent-provisioning-service';

function makeService(): AgentProvisioningService {
  const db: any = { collection: () => ({}) };
  const mcaService: any = {};
  return new AgentProvisioningService(db, mcaService);
}

describe('AgentProvisioningService.resolveCoreType', () => {
  it('maps global/personal agents (no workspace) to super-agent', () => {
    const svc = makeService();
    expect(svc.resolveCoreType(undefined)).toBe('super-agent');
    expect(svc.resolveCoreType('')).toBe('super-agent');
  });

  it('maps workspace-scoped agents to agent', () => {
    const svc = makeService();
    expect(svc.resolveCoreType('work_abc123')).toBe('agent');
  });
});

describe('AgentProvisioningService.createAgentFromCore (canonical shape)', () => {
  const REQUIRED_KEYS = [
    'agentId',
    'coreId',
    'name',
    'fullName',
    'role',
    'intro',
    'avatarUrl',
    'status',
    'ownerId',
    'availableProviders',
    'selectedProviderId',
    'selectedModelId',
    'createdAt',
    'updatedAt',
  ];

  function makeService(): { svc: AgentProvisioningService; inserted: () => any } {
    let captured: any = null;
    const db: any = {
      collection: (name: string) => {
        if (name === 'agents') return { insertOne: async (doc: any) => { captured = doc; } };
        if (name === 'agent_cores') {
          return { findOne: async () => ({ coreId: 'agent', avatarUrl: 'core.jpg', status: 'active' }) };
        }
        if (name === 'users') return { findOne: async () => null };
        return {};
      },
    };
    const mcaService: any = { ensureProvisionedApps: async () => {} };
    return { svc: new AgentProvisioningService(db, mcaService), inserted: () => captured };
  }

  it('produces a doc with every required field and the canonical defaults', async () => {
    const { svc, inserted } = makeService();
    await svc.createAgentFromCore({
      ownerId: 'u1',
      workspaceId: 'work_1',
      profile: { name: 'A', fullName: 'A B', role: 'r', intro: 'i' },
    });
    const doc = inserted();
    for (const key of REQUIRED_KEYS) {
      expect(doc).toHaveProperty(key);
    }
    expect(doc.status).toBe('active');
    expect(doc.availableProviders).toEqual([]);
    expect(doc.selectedProviderId).toBeNull();
    expect(doc.selectedModelId).toBeNull();
    expect(doc.coreId).toBe('agent'); // workspace scope → agent core
  });
});

describe('AgentProvisioningService.createAgentFromCore (provisioning rollback)', () => {
  function makeService(): { svc: AgentProvisioningService; inserted: () => any; deleted: () => any } {
    let insertedDoc: any = null;
    let deletedFilter: any = null;
    const db: any = {
      collection: (name: string) => {
        if (name === 'agents') {
          return {
            insertOne: async (doc: any) => { insertedDoc = doc; },
            deleteOne: async (filter: any) => { deletedFilter = filter; },
          };
        }
        if (name === 'agent_cores') {
          return { findOne: async () => ({ coreId: 'agent', avatarUrl: 'core.jpg', status: 'active' }) };
        }
        if (name === 'users') return { findOne: async () => null };
        return {};
      },
    };
    const mcaService: any = {
      ensureProvisionedApps: async () => { throw new Error('provisioning boom'); },
    };
    return {
      svc: new AgentProvisioningService(db, mcaService),
      inserted: () => insertedDoc,
      deleted: () => deletedFilter,
    };
  }

  it('rolls back the inserted agent and rethrows when provisioning fails', async () => {
    const { svc, inserted, deleted } = makeService();
    let thrown: unknown = null;
    try {
      await svc.createAgentFromCore({
        ownerId: 'u1',
        workspaceId: 'work_1',
        profile: { name: 'A', fullName: 'A B', role: 'r', intro: 'i' },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('provisioning boom');
    // The half-created agent must be deleted by the exact id that was inserted.
    expect(deleted()).toEqual({ agentId: inserted().agentId });
  });
});

describe('AgentProvisioningService.backfillCoreApps', () => {
  type Call = { agentId: string; workspaceId: string };

  function makeServiceWith(
    agents: Array<{ agentId: string; ownerId?: string; workspaceId?: string }>,
    usersById: Record<string, { privateWorkspaceId?: string }>,
    opts: { failFor?: string } = {},
  ): { svc: AgentProvisioningService; calls: Call[] } {
    const calls: Call[] = [];
    const db: any = {
      collection: (name: string) => {
        if (name === 'agents') return { find: () => ({ toArray: async () => agents }) };
        if (name === 'users') {
          return { findOne: async (q: { userId: string }) => usersById[q.userId] ?? null };
        }
        return {};
      },
    };
    const mcaService: any = {
      ensureProvisionedApps: async (agentId: string, workspaceId: string) => {
        if (opts.failFor === agentId) throw new Error('boom');
        calls.push({ agentId, workspaceId });
      },
    };
    return { svc: new AgentProvisioningService(db, mcaService), calls };
  }

  it('provisions workspace agents against their own workspace', async () => {
    const { svc, calls } = makeServiceWith([{ agentId: 'a1', ownerId: 'u1', workspaceId: 'work_1' }], {});
    const res = await svc.backfillCoreApps();
    expect(calls).toEqual([{ agentId: 'a1', workspaceId: 'work_1' }]);
    expect(res).toEqual({ processed: 1, provisioned: 1, skipped: 0, failed: 0 });
  });

  it('provisions super-agents against the owner private workspace (mirrors creation)', async () => {
    const { svc, calls } = makeServiceWith(
      [{ agentId: 'sa1', ownerId: 'u1' }],
      { u1: { privateWorkspaceId: 'work_priv1' } },
    );
    const res = await svc.backfillCoreApps();
    expect(calls).toEqual([{ agentId: 'sa1', workspaceId: 'work_priv1' }]);
    expect(res.provisioned).toBe(1);
  });

  it('skips super-agents whose owner has no private workspace (cannot provision)', async () => {
    const { svc, calls } = makeServiceWith([{ agentId: 'sa2', ownerId: 'u2' }], {});
    const res = await svc.backfillCoreApps();
    expect(calls).toEqual([]);
    expect(res).toEqual({ processed: 1, provisioned: 0, skipped: 1, failed: 0 });
  });

  it('isolates a per-agent failure without aborting the rest', async () => {
    const { svc, calls } = makeServiceWith(
      [
        { agentId: 'a1', ownerId: 'u1', workspaceId: 'work_1' },
        { agentId: 'a2', ownerId: 'u1', workspaceId: 'work_2' },
        { agentId: 'a3', ownerId: 'u1', workspaceId: 'work_3' },
      ],
      {},
      { failFor: 'a2' },
    );
    const res = await svc.backfillCoreApps();
    expect(calls.map((c) => c.agentId)).toEqual(['a1', 'a3']);
    expect(res).toEqual({ processed: 3, provisioned: 2, skipped: 0, failed: 1 });
  });
});
