/**
 * Unit tests — WS skill handlers (grant-access, set-enabled, revoke-access)
 *
 * Verifies:
 *   1. Required field validation (agentId, skillId, enabled where applicable)
 *   2. 404 SKILL_NOT_FOUND when the skill does not exist (grant-access)
 *   3. 404 SKILL_ACCESS_NOT_FOUND when no access entry exists (set-enabled, revoke-access)
 *   4. 403 FORBIDDEN_AGENT when ctx.userId has no access to the agent
 *   5. 403 FORBIDDEN_WORKSPACE when ctx.userId has no access to the skill's workspace
 *   6. Happy path: service is called with the correct derived workspaceId
 *   7. Client does NOT pass workspaceId — it is derived server-side
 *
 * No real MongoDB — Db and SkillService are mocked.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createGrantSkillAccessHandler } from '../../src/handlers/domains/skill/grant-access';
import { createSetSkillEnabledHandler } from '../../src/handlers/domains/skill/set-enabled';
import { createRevokeSkillAccessHandler } from '../../src/handlers/domains/skill/revoke-access';
import type { SkillService } from '../../src/services/skill-service';
import type { AgentSkillAccess, Skill } from '../../src/types/database';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const USER_ALICE = 'user_alice';
const USER_BOB = 'user_bob';
const WORKSPACE_ALICE = 'work_alice';
const WORKSPACE_BOB = 'work_bob';
const AGENT_ALICE = 'agent_alice';
const AGENT_BOB = 'agent_bob';
const SKILL_ID = 'sk_test_001';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    skillId: SKILL_ID,
    workspaceId: WORKSPACE_ALICE,
    name: 'Test Skill',
    content: '# Skill content',
    tags: [],
    createdBy: USER_ALICE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAccess(overrides: Partial<AgentSkillAccess> = {}): AgentSkillAccess {
  return {
    agentId: AGENT_ALICE,
    skillId: SKILL_ID,
    workspaceId: WORKSPACE_ALICE,
    enabled: true,
    order: 0,
    grantedBy: USER_ALICE,
    grantedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a mock Db where:
 *  - workspace WORKSPACE_ALICE is owned by USER_ALICE
 *  - workspace WORKSPACE_BOB is owned by USER_BOB
 *  - agent AGENT_ALICE belongs to WORKSPACE_ALICE
 *  - agent AGENT_BOB belongs to WORKSPACE_BOB
 *  - no extra memberships (no cross-workspace access)
 */
function makeDb() {
  return {
    collection: mock((name: string) => {
      const collections: Record<string, any> = {
        workspaces: {
          findOne: mock(async (filter: any) => {
            if (filter.workspaceId === WORKSPACE_ALICE) {
              return { workspaceId: WORKSPACE_ALICE, ownerId: USER_ALICE, status: 'active' };
            }
            if (filter.workspaceId === WORKSPACE_BOB) {
              return { workspaceId: WORKSPACE_BOB, ownerId: USER_BOB, status: 'active' };
            }
            return null;
          }),
        },
        workspace_members: {
          findOne: mock(async () => null),
          find: mock(() => ({ toArray: mock(async () => []) })),
        },
        agents: {
          findOne: mock(async (filter: any) => {
            if (filter.agentId === AGENT_ALICE) {
              return { agentId: AGENT_ALICE, workspaceId: WORKSPACE_ALICE, ownerId: USER_ALICE };
            }
            if (filter.agentId === AGENT_BOB) {
              return { agentId: AGENT_BOB, workspaceId: WORKSPACE_BOB, ownerId: USER_BOB };
            }
            return null;
          }),
        },
      };
      return collections[name] ?? { findOne: mock(async () => null) };
    }),
  } as any;
}

function makeSkillService(overrides: Partial<SkillService> = {}): SkillService {
  return {
    getSkill: mock(async () => makeSkill()),
    getAccessEntry: mock(async () => makeAccess()),
    grantSkillAccess: mock(async () => makeAccess()),
    setSkillEnabled: mock(async () => makeAccess()),
    revokeSkillAccess: mock(async () => true),
    ...overrides,
  } as any;
}

function ctx(userId: string): WsHandlerContext {
  return { userId, connectionId: 'conn_test', sessionId: 'sess_test' } as WsHandlerContext;
}

// ---------------------------------------------------------------------------
// grant-access
// ---------------------------------------------------------------------------

describe('skill.grant-access handler', () => {
  it('rejects missing agentId', async () => {
    const handler = createGrantSkillAccessHandler(makeSkillService(), makeDb());
    await expect(handler(ctx(USER_ALICE), { skillId: SKILL_ID })).rejects.toMatchObject({
      code: 'MISSING_AGENT_ID',
    });
  });

  it('rejects missing skillId', async () => {
    const handler = createGrantSkillAccessHandler(makeSkillService(), makeDb());
    await expect(handler(ctx(USER_ALICE), { agentId: AGENT_ALICE })).rejects.toMatchObject({
      code: 'MISSING_SKILL_ID',
    });
  });

  it('returns SKILL_NOT_FOUND if the skill does not exist', async () => {
    const svc = makeSkillService({ getSkill: mock(async () => null) as any });
    const handler = createGrantSkillAccessHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'SKILL_NOT_FOUND' });
  });

  it('returns FORBIDDEN_AGENT when user has no access to the target agent', async () => {
    // Alice tries to grant skill to Bob's agent
    const handler = createGrantSkillAccessHandler(makeSkillService(), makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_BOB, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_AGENT' });
  });

  it("returns FORBIDDEN_WORKSPACE when user has no access to the skill's workspace", async () => {
    // Skill belongs to Bob's workspace; Alice has access to her own agent only
    const svc = makeSkillService({
      getSkill: mock(async () => makeSkill({ workspaceId: WORKSPACE_BOB })) as any,
    });
    const db = makeDb();
    // Override agents.findOne so AGENT_ALICE is in WORKSPACE_BOB → canAccessAgent succeeds via membership lookup → but membership is empty so it fails
    // Instead, simulate: Alice owns AGENT_ALICE which lives in her workspace, but skill lives in Bob's workspace
    const handler = createGrantSkillAccessHandler(svc, db);
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
  });

  it('happy path: derives workspaceId from skill and calls service', async () => {
    const grantSkillAccessMock = mock(async () => makeAccess());
    const svc = makeSkillService({ grantSkillAccess: grantSkillAccessMock as any });
    const handler = createGrantSkillAccessHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_ALICE,
      skillId: SKILL_ID,
    });

    expect(result).toMatchObject({ access: expect.any(Object) });
    expect(grantSkillAccessMock).toHaveBeenCalledWith(
      AGENT_ALICE,
      SKILL_ID,
      WORKSPACE_ALICE, // derived from skill, NOT from client payload
      USER_ALICE,
      undefined,
    );
  });

  it('ignores workspaceId from client payload (server is authoritative)', async () => {
    const grantSkillAccessMock = mock(async () => makeAccess());
    const svc = makeSkillService({ grantSkillAccess: grantSkillAccessMock as any });
    const handler = createGrantSkillAccessHandler(svc, makeDb());

    await handler(ctx(USER_ALICE), {
      agentId: AGENT_ALICE,
      skillId: SKILL_ID,
      workspaceId: 'work_attacker_injected', // attacker tries to inject
    } as any);

    // Service was called with WORKSPACE_ALICE (from skill), NOT the injected value
    expect(grantSkillAccessMock.mock.calls[0][2]).toBe(WORKSPACE_ALICE);
  });
});

// ---------------------------------------------------------------------------
// set-enabled
// ---------------------------------------------------------------------------

describe('skill.set-enabled handler', () => {
  it('rejects missing agentId', async () => {
    const handler = createSetSkillEnabledHandler(makeSkillService(), makeDb());
    await expect(
      handler(ctx(USER_ALICE), { skillId: SKILL_ID, enabled: true }),
    ).rejects.toMatchObject({ code: 'MISSING_AGENT_ID' });
  });

  it('rejects missing skillId', async () => {
    const handler = createSetSkillEnabledHandler(makeSkillService(), makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, enabled: true }),
    ).rejects.toMatchObject({ code: 'MISSING_SKILL_ID' });
  });

  it('rejects non-boolean enabled', async () => {
    const handler = createSetSkillEnabledHandler(makeSkillService(), makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'MISSING_ENABLED' });
  });

  it('returns SKILL_ACCESS_NOT_FOUND when there is no access entry', async () => {
    const svc = makeSkillService({ getAccessEntry: mock(async () => null) as any });
    const handler = createSetSkillEnabledHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID, enabled: false }),
    ).rejects.toMatchObject({ code: 'SKILL_ACCESS_NOT_FOUND' });
  });

  it('returns FORBIDDEN_AGENT when user has no access to the agent', async () => {
    const svc = makeSkillService({
      getAccessEntry: mock(async () => makeAccess({ agentId: AGENT_BOB })) as any,
    });
    const handler = createSetSkillEnabledHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_BOB, skillId: SKILL_ID, enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_AGENT' });
  });

  it("returns FORBIDDEN_WORKSPACE when user has no access to the access entry's workspace", async () => {
    const svc = makeSkillService({
      getAccessEntry: mock(async () => makeAccess({ workspaceId: WORKSPACE_BOB })) as any,
    });
    const handler = createSetSkillEnabledHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID, enabled: false }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
  });

  it('happy path: calls service.setSkillEnabled', async () => {
    const setEnabledMock = mock(async () => makeAccess({ enabled: false }));
    const svc = makeSkillService({ setSkillEnabled: setEnabledMock as any });
    const handler = createSetSkillEnabledHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_ALICE,
      skillId: SKILL_ID,
      enabled: false,
    });

    expect(result).toEqual({ success: true });
    expect(setEnabledMock).toHaveBeenCalledWith(AGENT_ALICE, SKILL_ID, false);
  });
});

// ---------------------------------------------------------------------------
// revoke-access
// ---------------------------------------------------------------------------

describe('skill.revoke-access handler', () => {
  it('rejects missing agentId', async () => {
    const handler = createRevokeSkillAccessHandler(makeSkillService(), makeDb());
    await expect(handler(ctx(USER_ALICE), { skillId: SKILL_ID })).rejects.toMatchObject({
      code: 'MISSING_AGENT_ID',
    });
  });

  it('rejects missing skillId', async () => {
    const handler = createRevokeSkillAccessHandler(makeSkillService(), makeDb());
    await expect(handler(ctx(USER_ALICE), { agentId: AGENT_ALICE })).rejects.toMatchObject({
      code: 'MISSING_SKILL_ID',
    });
  });

  it('returns FORBIDDEN_AGENT when user has no access to the target agent', async () => {
    const svc = makeSkillService({
      getAccessEntry: mock(async () => makeAccess({ agentId: AGENT_BOB })) as any,
    });
    const handler = createRevokeSkillAccessHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_BOB, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_AGENT' });
  });

  it('returns SKILL_ACCESS_NOT_FOUND when there is no entry to revoke', async () => {
    const svc = makeSkillService({ getAccessEntry: mock(async () => null) as any });
    const handler = createRevokeSkillAccessHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'SKILL_ACCESS_NOT_FOUND' });
  });

  it("returns FORBIDDEN_WORKSPACE when user has no access to the entry's workspace", async () => {
    const svc = makeSkillService({
      getAccessEntry: mock(async () => makeAccess({ workspaceId: WORKSPACE_BOB })) as any,
    });
    const handler = createRevokeSkillAccessHandler(svc, makeDb());
    await expect(
      handler(ctx(USER_ALICE), { agentId: AGENT_ALICE, skillId: SKILL_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_WORKSPACE' });
  });

  it('happy path: calls service.revokeSkillAccess', async () => {
    const revokeMock = mock(async () => true);
    const svc = makeSkillService({ revokeSkillAccess: revokeMock as any });
    const handler = createRevokeSkillAccessHandler(svc, makeDb());

    const result = await handler(ctx(USER_ALICE), {
      agentId: AGENT_ALICE,
      skillId: SKILL_ID,
    });

    expect(result).toEqual({ success: true });
    expect(revokeMock).toHaveBeenCalledWith(AGENT_ALICE, SKILL_ID);
  });
});
