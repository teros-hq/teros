/**
 * Unit tests — workspace-access.ts authz helpers
 *
 * Single source of truth for membership/ownership checks. Tests cover:
 *   - getUserWorkspaceIds: mapping memberships → workspaceIds
 *   - canAccessWorkspace: owner branch + member branch + no-access branch
 *   - canAccessAgent: global agent (workspaceId null) + workspace agent + missing
 *   - canAccessApp: legacy user-owned + workspace-owned + missing
 *
 * Db is fully mocked — no real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test';
import {
  canAccessAgent,
  canAccessApp,
  canAccessWorkspace,
  getUserWorkspaceIds,
} from '../../src/auth/workspace-access';

// ---------------------------------------------------------------------------
// Mock Db builder — composable per-test
// ---------------------------------------------------------------------------

interface DbFixture {
  workspaces?: Array<{ workspaceId: string; ownerId: string; status?: string }>;
  memberships?: Array<{ workspaceId: string; userId: string }>;
  agents?: Array<{ agentId: string; workspaceId?: string | null; ownerId?: string }>;
  apps?: Array<{ appId: string; ownerType: 'user' | 'workspace'; ownerId: string }>;
}

function makeDb(fixture: DbFixture = {}): any {
  return {
    collection: mock((name: string) => {
      switch (name) {
        case 'workspaces':
          return {
            findOne: mock(async (f: any) =>
              fixture.workspaces?.find(
                (w) =>
                  w.workspaceId === f.workspaceId &&
                  (f.ownerId === undefined || w.ownerId === f.ownerId) &&
                  (f.status === undefined || w.status === f.status),
              ) ?? null,
            ),
            // Mirrors getUserWorkspaceIds: find({ workspaceId: { $in }, status }).project().toArray()
            find: mock((f: any) => ({
              project: mock(() => ({
                toArray: mock(async () =>
                  (fixture.workspaces ?? []).filter(
                    (w) =>
                      (f.workspaceId?.$in === undefined ||
                        f.workspaceId.$in.includes(w.workspaceId)) &&
                      (f.status === undefined || w.status === f.status),
                  ),
                ),
              })),
            })),
          };
        case 'workspace_members':
          return {
            findOne: mock(async (f: any) =>
              fixture.memberships?.find(
                (m) => m.workspaceId === f.workspaceId && m.userId === f.userId,
              ) ?? null,
            ),
            find: mock((f: any) => ({
              toArray: mock(async () =>
                (fixture.memberships ?? []).filter((m) => m.userId === f.userId),
              ),
            })),
          };
        case 'agents':
          return {
            findOne: mock(async (f: any) =>
              fixture.agents?.find((a) => a.agentId === f.agentId) ?? null,
            ),
          };
        case 'apps':
          return {
            findOne: mock(async (f: any) =>
              fixture.apps?.find((a) => a.appId === f.appId) ?? null,
            ),
          };
        default:
          return { findOne: mock(async () => null) };
      }
    }),
  };
}

// ---------------------------------------------------------------------------
// getUserWorkspaceIds
// ---------------------------------------------------------------------------

describe('getUserWorkspaceIds', () => {
  it('returns empty array when user has no memberships', async () => {
    const db = makeDb({ memberships: [] });
    expect(await getUserWorkspaceIds(db, 'user_alice')).toEqual([]);
  });

  it('returns all active workspace ids the user is a member of', async () => {
    const db = makeDb({
      workspaces: [
        { workspaceId: 'work_1', ownerId: 'user_owner', status: 'active' },
        { workspaceId: 'work_2', ownerId: 'user_owner', status: 'active' },
        { workspaceId: 'work_3', ownerId: 'user_owner', status: 'active' },
      ],
      memberships: [
        { workspaceId: 'work_1', userId: 'user_alice' },
        { workspaceId: 'work_2', userId: 'user_alice' },
        { workspaceId: 'work_3', userId: 'user_bob' }, // should NOT appear for alice
      ],
    });
    const ids = await getUserWorkspaceIds(db, 'user_alice');
    expect(ids.sort()).toEqual(['work_1', 'work_2']);
  });

  it('excludes archived workspaces even when the user is still a member', async () => {
    const db = makeDb({
      workspaces: [
        { workspaceId: 'work_active', ownerId: 'user_owner', status: 'active' },
        { workspaceId: 'work_archived', ownerId: 'user_owner', status: 'archived' },
      ],
      memberships: [
        { workspaceId: 'work_active', userId: 'user_alice' },
        { workspaceId: 'work_archived', userId: 'user_alice' },
      ],
    });
    const ids = await getUserWorkspaceIds(db, 'user_alice');
    expect(ids).toEqual(['work_active']);
  });
});

// ---------------------------------------------------------------------------
// canAccessWorkspace
// ---------------------------------------------------------------------------

describe('canAccessWorkspace', () => {
  it('grants access to the workspace owner', async () => {
    const db = makeDb({
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'active' }],
    });
    expect(await canAccessWorkspace(db, 'user_alice', 'work_1')).toBe(true);
  });

  it('grants access to a member (non-owner)', async () => {
    const db = makeDb({
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_bob', status: 'active' }],
      memberships: [{ workspaceId: 'work_1', userId: 'user_alice' }],
    });
    expect(await canAccessWorkspace(db, 'user_alice', 'work_1')).toBe(true);
  });

  it('denies non-member non-owner', async () => {
    const db = makeDb({
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_bob', status: 'active' }],
      memberships: [],
    });
    expect(await canAccessWorkspace(db, 'user_alice', 'work_1')).toBe(false);
  });

  it('denies access to a non-existent workspace', async () => {
    const db = makeDb({});
    expect(await canAccessWorkspace(db, 'user_alice', 'work_ghost')).toBe(false);
  });

  it('denies access when workspace is archived', async () => {
    const db = makeDb({
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'archived' }],
      memberships: [{ workspaceId: 'work_1', userId: 'user_bob' }],
    });
    expect(await canAccessWorkspace(db, 'user_alice', 'work_1')).toBe(false);
    expect(await canAccessWorkspace(db, 'user_bob', 'work_1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canAccessAgent
// ---------------------------------------------------------------------------

describe('canAccessAgent', () => {
  it('grants access to a global agent (workspaceId null) owned by the user', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: null, ownerId: 'user_alice' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(true);
  });

  it('denies access to a global agent owned by another user', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: null, ownerId: 'user_bob' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(false);
  });

  it('grants access to a workspace agent when the user is the workspace owner', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: 'work_1', ownerId: 'user_bob' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'active' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(true);
  });

  it('grants access to a workspace agent when the user is a member', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: 'work_1', ownerId: 'user_bob' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_carl', status: 'active' }],
      memberships: [{ workspaceId: 'work_1', userId: 'user_alice' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(true);
  });

  it('denies access to a workspace agent when the user is neither owner nor member', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: 'work_1', ownerId: 'user_bob' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_bob', status: 'active' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(false);
  });

  it('denies access to a workspace agent when the workspace is archived (even for the owner)', async () => {
    const db = makeDb({
      agents: [{ agentId: 'agent_1', workspaceId: 'work_1', ownerId: 'user_bob' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'archived' }],
    });
    expect(await canAccessAgent(db, 'user_alice', 'agent_1')).toBe(false);
  });

  it('denies access to a non-existent agent', async () => {
    const db = makeDb({});
    expect(await canAccessAgent(db, 'user_alice', 'agent_ghost')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canAccessApp
// ---------------------------------------------------------------------------

describe('canAccessApp', () => {
  it('grants access to a legacy user-owned app for its owner', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'user', ownerId: 'user_alice' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(true);
  });

  it('denies access to a legacy user-owned app for another user', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'user', ownerId: 'user_bob' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(false);
  });

  it('grants access to a workspace-owned app when the user has workspace access (owner)', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'workspace', ownerId: 'work_1' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'active' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(true);
  });

  it('grants access to a workspace-owned app when the user has workspace access (member)', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'workspace', ownerId: 'work_1' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_carl', status: 'active' }],
      memberships: [{ workspaceId: 'work_1', userId: 'user_alice' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(true);
  });

  it('denies access to a workspace-owned app for non-member non-owner', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'workspace', ownerId: 'work_1' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_bob', status: 'active' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(false);
  });

  it('denies access to a workspace-owned app when its workspace is archived (even for the owner)', async () => {
    const db = makeDb({
      apps: [{ appId: 'app_1', ownerType: 'workspace', ownerId: 'work_1' }],
      workspaces: [{ workspaceId: 'work_1', ownerId: 'user_alice', status: 'archived' }],
    });
    expect(await canAccessApp(db, 'user_alice', 'app_1')).toBe(false);
  });

  it('denies access to a non-existent app', async () => {
    const db = makeDb({});
    expect(await canAccessApp(db, 'user_alice', 'app_ghost')).toBe(false);
  });
});
