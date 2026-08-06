/**
 * Unit — Workspace Is Sovereign authz (TER-457, principle 6)
 *
 * Every workspace mutation is gated by membership/role. `canAdmin` is the shared
 * gate (owner or admin member only); update/archive/addMember all hang off it (or
 * off owner-only). A regression that let a writer or a stranger mutate a workspace
 * would breach the sovereignty invariant silently. This drives the role matrix and
 * the denial paths directly over an in-memory `workspaces` collection.
 */

import { describe, expect, it } from 'bun:test';
import { WorkspaceService } from '../../../packages/backend/src/services/workspace-service';

const OWNER = 'user_owner';
const ADMIN = 'user_admin';
const WRITER = 'user_writer';
const STRANGER = 'user_stranger';

function makeService(workspace: any) {
  let current = workspace;
  const collection = {
    findOne: async (q: any) => (current && current.workspaceId === q.workspaceId ? current : null),
    findOneAndUpdate: async (_q: any, u: any) => {
      current = { ...current, ...(u.$set ?? {}) };
      return current;
    },
    updateOne: async (_q: any, u: any) => {
      current = { ...current, ...(u.$set ?? {}) };
      return { modifiedCount: 1 };
    },
    createIndex: async () => undefined,
  };
  const db = { collection: () => collection } as any;
  return new WorkspaceService(db, {} as any);
}

const WS = () => ({
  workspaceId: 'work_1',
  ownerId: OWNER,
  status: 'active',
  members: [
    { userId: ADMIN, role: 'admin' },
    { userId: WRITER, role: 'write' },
  ],
});

describe('canAdmin — role matrix', () => {
  it('grants the owner', async () => {
    expect(await makeService(WS()).canAdmin('work_1', OWNER)).toBe(true);
  });
  it('grants an admin member', async () => {
    expect(await makeService(WS()).canAdmin('work_1', ADMIN)).toBe(true);
  });
  it('denies a write member (not admin)', async () => {
    expect(await makeService(WS()).canAdmin('work_1', WRITER)).toBe(false);
  });
  it('denies a stranger', async () => {
    expect(await makeService(WS()).canAdmin('work_1', STRANGER)).toBe(false);
  });
  it('denies everyone on an inactive workspace', async () => {
    expect(await makeService({ ...WS(), status: 'archived' }).canAdmin('work_1', OWNER)).toBe(false);
  });
});

describe('updateWorkspace — admin gate', () => {
  it('rejects a write member', async () => {
    await expect(makeService(WS()).updateWorkspace('work_1', WRITER, { name: 'x' })).rejects.toThrow(/Permission denied/);
  });
  it('rejects a stranger', async () => {
    await expect(makeService(WS()).updateWorkspace('work_1', STRANGER, { name: 'x' })).rejects.toThrow(/Permission denied/);
  });
  it('allows the owner', async () => {
    const result = await makeService(WS()).updateWorkspace('work_1', OWNER, { name: 'Renamed' });
    expect(result?.name).toBe('Renamed');
  });
});

describe('archiveWorkspace — owner-only', () => {
  it('rejects an admin member (only the owner may archive)', async () => {
    await expect(makeService(WS()).archiveWorkspace('work_1', ADMIN)).rejects.toThrow(/only owner/);
  });
  it('returns false for a non-existent workspace (no throw, no leak)', async () => {
    expect(await makeService(WS()).archiveWorkspace('work_missing', OWNER)).toBe(false);
  });
  it('allows the owner', async () => {
    expect(await makeService(WS()).archiveWorkspace('work_1', OWNER)).toBe(true);
  });
});

describe('addMember — admin gate', () => {
  it('rejects a write member adding others', async () => {
    await expect(makeService(WS()).addMember('work_1', 'user_new', 'write', WRITER)).rejects.toThrow(/Permission denied/);
  });
});

describe('removeMember — admin gate', () => {
  it('rejects a write member removing others', async () => {
    await expect(makeService(WS()).removeMember('work_1', ADMIN, WRITER)).rejects.toThrow(/Permission denied/);
  });
  it('rejects a stranger removing members', async () => {
    await expect(makeService(WS()).removeMember('work_1', ADMIN, STRANGER)).rejects.toThrow(/Permission denied/);
  });
});
