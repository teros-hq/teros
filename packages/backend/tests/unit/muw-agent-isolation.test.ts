/**
 * MUW Agent Isolation — SEC-2 class: usableAgentFilter leak fix.
 *
 * Verifies that workspace members cannot see or use the workspace owner's
 * personal superagents.  The fix in channel-authz.ts removed
 * `workspaceOwnerId` from the superagent owner IDs so that only the caller's
 * own superagents are visible/usable.
 *
 * Test matrix:
 *   1. Workspace member lists agents → does NOT see workspace owner's superagents
 *   2. Workspace owner lists agents → sees their own superagents + workspace agents
 *   3. Workspace member tries to create channel with owner's superagent → ACCESS_DENIED
 *   4. Workspace owner creates channel with their own superagent in the workspace → success
 *   5. Workspace agents visible to all members (unchanged)
 *   6. Superagents listed first, then workspace agents (ordering)
 */

import { describe, expect, it } from 'bun:test';
import { usableAgentFilter, assertCanCreateChannel } from '../../src/services/channel-authz';
import { HandlerError } from '../../src/ws-framework/WsRouter';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory Db fixture (same pattern as muw-3-visibility.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as any[]).some((sub) => matches(doc, sub));
    }
    if (key === '$and') {
      return (cond as any[]).every((sub) => matches(doc, sub));
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond as any).every(([op, opVal]) => {
        if (op === '$in') return (opVal as any[]).includes(doc[key]);
        if (op === '$ne') return doc[key] !== opVal;
        if (op === '$exists') return (doc[key] !== undefined) === opVal;
        throw new Error(`operator not implemented in fixture: ${op}`);
      });
    }
    return doc[key] === cond;
  });
}

function makeCollection(docs: any[]) {
  return {
    findOne: async (filter: any) => docs.find((d) => matches(d, filter)) ?? null,
    find: (filter: any) => ({
      toArray: async () => docs.filter((d) => matches(d, filter)),
      sort: () => ({
        limit: () => ({ toArray: async () => docs.filter((d) => matches(d, filter)) }),
      }),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = 'user_owner';
const MEMBER_ID = 'user_member';
const WORKSPACE_ID = 'work_shared';

// Owner's personal superagent (no workspaceId)
const OWNER_SUPERAGENT = {
  agentId: 'agent_owner_super',
  name: 'Alice',
  fullName: 'Alice (Owner Superagent)',
  ownerId: OWNER_ID,
  workspaceId: null,
  coreId: 'core_alice',
};

// Member's personal superagent (no workspaceId)
const MEMBER_SUPERAGENT = {
  agentId: 'agent_member_super',
  name: 'Bob',
  fullName: 'Bob (Member Superagent)',
  ownerId: MEMBER_ID,
  workspaceId: null,
  coreId: 'core_bob',
};

// Workspace agent (visible to all members)
const WORKSPACE_AGENT = {
  agentId: 'agent_workspace',
  name: 'Workspace Bot',
  fullName: 'Workspace Bot',
  ownerId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  coreId: 'core_ws_bot',
};

const ALL_AGENTS = [OWNER_SUPERAGENT, MEMBER_SUPERAGENT, WORKSPACE_AGENT];

const WORKSPACE = {
  workspaceId: WORKSPACE_ID,
  ownerId: OWNER_ID,
  name: 'Shared Workspace',
  status: 'active',
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock workspace service
// ─────────────────────────────────────────────────────────────────────────────

function makeWorkspaceService(members: string[] = [OWNER_ID, MEMBER_ID]) {
  return {
    canAccess: async (wsId: string, userId: string) => {
      if (wsId !== WORKSPACE_ID) return false;
      return members.includes(userId);
    },
  } as any;
}

function makeDb() {
  const stores: Record<string, any[]> = {
    agents: [...ALL_AGENTS],
    workspaces: [WORKSPACE],
  };
  const db = {
    collection: (name: string) => {
      if (!stores[name]) stores[name] = [];
      return makeCollection(stores[name]);
    },
  } as any;
  return { db, stores };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: usableAgentFilter (unit-level)
// ─────────────────────────────────────────────────────────────────────────────

describe('MUW Agent Isolation: usableAgentFilter', () => {
  it('member does NOT match owner\'s superagent', () => {
    const filter = usableAgentFilter(MEMBER_ID, WORKSPACE_ID);
    // OWNER_SUPERAGENT should NOT match — it belongs to the owner, not the caller
    expect(matches(OWNER_SUPERAGENT, filter)).toBe(false);
  });

  it('member matches their own superagent', () => {
    const filter = usableAgentFilter(MEMBER_ID, WORKSPACE_ID);
    expect(matches(MEMBER_SUPERAGENT, filter)).toBe(true);
  });

  it('member matches workspace agents', () => {
    const filter = usableAgentFilter(MEMBER_ID, WORKSPACE_ID);
    expect(matches(WORKSPACE_AGENT, filter)).toBe(true);
  });

  it('owner matches their own superagent', () => {
    const filter = usableAgentFilter(OWNER_ID, WORKSPACE_ID);
    expect(matches(OWNER_SUPERAGENT, filter)).toBe(true);
  });

  it('owner matches workspace agents', () => {
    const filter = usableAgentFilter(OWNER_ID, WORKSPACE_ID);
    expect(matches(WORKSPACE_AGENT, filter)).toBe(true);
  });

  it('owner does NOT match member\'s superagent', () => {
    const filter = usableAgentFilter(OWNER_ID, WORKSPACE_ID);
    expect(matches(MEMBER_SUPERAGENT, filter)).toBe(false);
  });

  it('filter still works with _workspaceOwnerId parameter (API compat)', () => {
    // The parameter is accepted but ignored — result must be identical
    const withoutParam = usableAgentFilter(MEMBER_ID, WORKSPACE_ID);
    const withParam = usableAgentFilter(MEMBER_ID, WORKSPACE_ID, OWNER_ID);
    expect(withParam).toEqual(withoutParam);
  });

  it('full agent list for member: workspace agents + own superagents, NOT owner superagents', () => {
    const filter = usableAgentFilter(MEMBER_ID, WORKSPACE_ID);
    const visible = ALL_AGENTS.filter((a) => matches(a, filter));
    const visibleIds = visible.map((a) => a.agentId);

    expect(visibleIds).toContain('agent_workspace');
    expect(visibleIds).toContain('agent_member_super');
    expect(visibleIds).not.toContain('agent_owner_super');
  });

  it('full agent list for owner: workspace agents + own superagents, NOT member superagents', () => {
    const filter = usableAgentFilter(OWNER_ID, WORKSPACE_ID);
    const visible = ALL_AGENTS.filter((a) => matches(a, filter));
    const visibleIds = visible.map((a) => a.agentId);

    expect(visibleIds).toContain('agent_workspace');
    expect(visibleIds).toContain('agent_owner_super');
    expect(visibleIds).not.toContain('agent_member_super');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: assertCanCreateChannel (integration-level with mock DB)
// ─────────────────────────────────────────────────────────────────────────────


describe('MUW Agent Isolation: assertCanCreateChannel', () => {
  it('member CANNOT start a channel with owner\'s superagent → ACCESS_DENIED', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    await expect(
      assertCanCreateChannel(db, wsService, MEMBER_ID, WORKSPACE_ID, 'agent_owner_super'),
    ).rejects.toThrow(HandlerError);

    try {
      await assertCanCreateChannel(db, wsService, MEMBER_ID, WORKSPACE_ID, 'agent_owner_super');
    } catch (err: any) {
      expect(err.code).toBe('ACCESS_DENIED');
    }
  });

  it('member CAN start a channel with their own superagent', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    // Should not throw
    await assertCanCreateChannel(db, wsService, MEMBER_ID, WORKSPACE_ID, 'agent_member_super');
  });

  it('member CAN start a channel with a workspace agent', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    await assertCanCreateChannel(db, wsService, MEMBER_ID, WORKSPACE_ID, 'agent_workspace');
  });

  it('owner CAN start a channel with their own superagent in the workspace', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    await assertCanCreateChannel(db, wsService, OWNER_ID, WORKSPACE_ID, 'agent_owner_super');
  });

  it('owner CAN start a channel with a workspace agent', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    await assertCanCreateChannel(db, wsService, OWNER_ID, WORKSPACE_ID, 'agent_workspace');
  });

  it('owner CANNOT start a channel with member\'s superagent → ACCESS_DENIED', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService();

    await expect(
      assertCanCreateChannel(db, wsService, OWNER_ID, WORKSPACE_ID, 'agent_member_super'),
    ).rejects.toThrow(HandlerError);
  });

  it('non-member gets ACCESS_DENIED for workspace access', async () => {
    const { db } = makeDb();
    const wsService = makeWorkspaceService([OWNER_ID, MEMBER_ID]);

    await expect(
      assertCanCreateChannel(db, wsService, 'user_outsider', WORKSPACE_ID, 'agent_workspace'),
    ).rejects.toThrow(HandlerError);

    try {
      await assertCanCreateChannel(db, wsService, 'user_outsider', WORKSPACE_ID, 'agent_workspace');
    } catch (err: any) {
      expect(err.code).toBe('ACCESS_DENIED');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Superagent-first ordering (agent.list handler behavior)
// ─────────────────────────────────────────────────────────────────────────────

describe('MUW Agent Isolation: superagent-first ordering', () => {
  it('superagents (no workspaceId) sort before workspace agents', () => {
    // Simulate the sort logic from agent/list.ts
    const agentList = [
      { ...WORKSPACE_AGENT },
      { ...OWNER_SUPERAGENT },
      { ...WORKSPACE_AGENT, agentId: 'agent_workspace_2' },
    ];

    agentList.sort((a, b) => {
      const aIsSuper = !a.workspaceId;
      const bIsSuper = !b.workspaceId;
      if (aIsSuper && !bIsSuper) return -1;
      if (!aIsSuper && bIsSuper) return 1;
      return 0;
    });

    // Superagent should be first
    expect(agentList[0].agentId).toBe('agent_owner_super');
    // Workspace agents follow
    expect(agentList[1].workspaceId).toBe(WORKSPACE_ID);
    expect(agentList[2].workspaceId).toBe(WORKSPACE_ID);
  });

  it('ordering is stable when all agents are the same type', () => {
    const agentList = [
      { ...WORKSPACE_AGENT, agentId: 'ws_1' },
      { ...WORKSPACE_AGENT, agentId: 'ws_2' },
      { ...WORKSPACE_AGENT, agentId: 'ws_3' },
    ];

    const originalOrder = agentList.map((a) => a.agentId);

    agentList.sort((a, b) => {
      const aIsSuper = !a.workspaceId;
      const bIsSuper = !b.workspaceId;
      if (aIsSuper && !bIsSuper) return -1;
      if (!aIsSuper && bIsSuper) return 1;
      return 0;
    });

    // All workspace agents — order unchanged
    expect(agentList.map((a) => a.agentId)).toEqual(originalOrder);
  });
});
