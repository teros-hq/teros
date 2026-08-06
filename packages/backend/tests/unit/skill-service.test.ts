/**
 * Unit tests — SkillService
 *
 * Covers:
 *   - getAccessEntry: forwards filter to access collection, returns null when missing
 *   - grantSkillAccess: upserts with enabled:true (regression: the WS handler's
 *     contract relies on this — the toggle in AgentWindowContent no longer makes
 *     a second set-enabled call after grant-access)
 *   - grantSkillAccess: throws when skill does not exist
 *   - setSkillEnabled: returns null when entry not found
 *
 * Db is fully mocked — no real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test';
import { SkillService } from '../../src/services/skill-service';

// ---------------------------------------------------------------------------
// Mock Db builder — tracks calls so we can assert upsert semantics
// ---------------------------------------------------------------------------

interface CollectionStubs {
  findOne?: any;
  findOneAndUpdate?: any;
  updateOne?: any;
  deleteOne?: any;
  deleteMany?: any;
  insertOne?: any;
  find?: any;
}

function makeDb(collections: Record<string, CollectionStubs>): any {
  return {
    collection: mock((name: string) => {
      const stubs = collections[name] ?? {};
      return {
        findOne: stubs.findOne ?? mock(async () => null),
        findOneAndUpdate: stubs.findOneAndUpdate ?? mock(async () => null),
        updateOne: stubs.updateOne ?? mock(async () => ({ acknowledged: true })),
        deleteOne: stubs.deleteOne ?? mock(async () => ({ deletedCount: 1 })),
        deleteMany: stubs.deleteMany ?? mock(async () => ({ deletedCount: 0 })),
        insertOne: stubs.insertOne ?? mock(async () => ({ acknowledged: true })),
        find: stubs.find ?? mock(() => ({ sort: () => ({ toArray: async () => [] }) })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// getAccessEntry
// ---------------------------------------------------------------------------

describe('SkillService.getAccessEntry', () => {
  it('returns null when no entry exists for the (agentId, skillId) pair', async () => {
    const findOne = mock(async () => null);
    const db = makeDb({ agent_skill_access: { findOne } });
    const svc = new SkillService(db);

    const result = await svc.getAccessEntry('agent_1', 'sk_1');
    expect(result).toBeNull();
  });

  it('queries the access collection with the exact (agentId, skillId) filter', async () => {
    const stored = {
      agentId: 'agent_1',
      skillId: 'sk_1',
      workspaceId: 'work_1',
      enabled: true,
      order: 0,
      grantedBy: 'user_alice',
      grantedAt: new Date().toISOString(),
    };
    const findOne = mock(async () => stored);
    const db = makeDb({ agent_skill_access: { findOne } });
    const svc = new SkillService(db);

    const result = await svc.getAccessEntry('agent_1', 'sk_1');

    expect(findOne).toHaveBeenCalledWith({ agentId: 'agent_1', skillId: 'sk_1' });
    expect(result).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------
// grantSkillAccess — upsert with enabled:true (regression guard)
// ---------------------------------------------------------------------------

describe('SkillService.grantSkillAccess', () => {
  it('upserts the access entry with enabled:true (regression: handler depends on this)', async () => {
    const updateOne = mock(async () => ({ acknowledged: true, upsertedId: null }));
    const skillFindOne = mock(async () => ({
      skillId: 'sk_1',
      workspaceId: 'work_1',
      name: 'Test',
      content: '',
      tags: [],
      createdBy: 'user_alice',
      createdAt: 'now',
      updatedAt: 'now',
    }));
    const db = makeDb({
      skills: { findOne: skillFindOne },
      agent_skill_access: { updateOne },
    });
    const svc = new SkillService(db);

    await svc.grantSkillAccess('agent_1', 'sk_1', 'work_1', 'user_alice');

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, options] = updateOne.mock.calls[0];
    expect(filter).toEqual({ agentId: 'agent_1', skillId: 'sk_1' });
    expect(update).toMatchObject({
      $set: expect.objectContaining({
        agentId: 'agent_1',
        skillId: 'sk_1',
        workspaceId: 'work_1',
        enabled: true, // <-- the invariant the handler relies on
        order: 0,
        grantedBy: 'user_alice',
      }),
    });
    expect(options).toEqual({ upsert: true });
  });

  it('passes through a non-zero order when provided', async () => {
    const updateOne = mock(async () => ({ acknowledged: true }));
    const skillFindOne = mock(async () => ({
      skillId: 'sk_1',
      workspaceId: 'work_1',
      name: 'Test',
      content: '',
      tags: [],
      createdBy: 'user_alice',
      createdAt: 'now',
      updatedAt: 'now',
    }));
    const db = makeDb({
      skills: { findOne: skillFindOne },
      agent_skill_access: { updateOne },
    });
    const svc = new SkillService(db);

    await svc.grantSkillAccess('agent_1', 'sk_1', 'work_1', 'user_alice', 7);

    expect(updateOne.mock.calls[0][1].$set.order).toBe(7);
  });

  it('throws when the skill does not exist', async () => {
    const skillFindOne = mock(async () => null);
    const updateOne = mock(async () => ({ acknowledged: true }));
    const db = makeDb({
      skills: { findOne: skillFindOne },
      agent_skill_access: { updateOne },
    });
    const svc = new SkillService(db);

    await expect(
      svc.grantSkillAccess('agent_1', 'sk_ghost', 'work_1', 'user_alice'),
    ).rejects.toThrow(/Skill sk_ghost not found/);
    // Service must not write when validation fails
    expect(updateOne).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setSkillEnabled
// ---------------------------------------------------------------------------

describe('SkillService.setSkillEnabled', () => {
  it('returns null when the access entry does not exist', async () => {
    const findOneAndUpdate = mock(async () => null);
    const db = makeDb({ agent_skill_access: { findOneAndUpdate } });
    const svc = new SkillService(db);

    const result = await svc.setSkillEnabled('agent_1', 'sk_1', false);
    expect(result).toBeNull();
  });

  it('updates only the enabled flag (preserves other fields)', async () => {
    const findOneAndUpdate = mock(async () => ({
      agentId: 'agent_1',
      skillId: 'sk_1',
      workspaceId: 'work_1',
      enabled: false,
      order: 0,
      grantedBy: 'user_alice',
      grantedAt: 'now',
    }));
    const db = makeDb({ agent_skill_access: { findOneAndUpdate } });
    const svc = new SkillService(db);

    await svc.setSkillEnabled('agent_1', 'sk_1', false);

    const [filter, update] = findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ agentId: 'agent_1', skillId: 'sk_1' });
    expect(update).toEqual({ $set: { enabled: false } });
  });
});
