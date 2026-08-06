/**
 * ChannelManager tests (TER-456) — authz workspace-sovereign + lifecycle.
 *
 * Cubre el scope del ticket: canAccessChannel (las 4 ramas de acceso),
 * cleanupExpiredPrivateChannels (ventana de 15 días + borrado completo) y
 * setRunning (shape exacto del update). 0 tests directos previos.
 *
 * Db mockeada en memoria con filtros EVALUADOS fielmente (patrón
 * workspace-access.test.ts): el $or de workspaces con dot-notation
 * 'members.userId' y el $lt sobre updatedAt se ejercitan de verdad.
 */

import { describe, expect, it } from 'bun:test';
import { ChannelManager } from '../../src/services/channel-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture de Db en memoria con matching fiel de los filtros usados
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
  channels?: any[];
  workspaces?: any[];
  messages?: any[];
  agentConfigs?: any[];
  users?: any[];
}

/** Evalúa el subconjunto de query-language de Mongo que usan los métodos bajo test. */
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') {
      return (cond as any[]).some((sub) => matches(doc, sub));
    }
    // dot-notation: 'members.userId' — matchea si ALGÚN elemento del array cumple
    if (key.includes('.')) {
      const [head, tail] = key.split('.', 2);
      const value = doc[head];
      if (Array.isArray(value)) return value.some((el) => matches(el, { [tail]: cond }));
      return value ? matches(value, { [tail]: cond }) : false;
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond as any).every(([op, opVal]) => {
        if (op === '$lt') return doc[key] < (opVal as any);
        if (op === '$gt') return doc[key] > (opVal as any);
        if (op === '$in') return (opVal as any[]).includes(doc[key]);
        if (op === '$ne') return doc[key] !== opVal;
        if (op === '$exists') return (doc[key] !== undefined) === opVal;
        throw new Error(`operator not implemented in fixture: ${op}`);
      });
    }
    return doc[key] === cond;
  });
}

function makeCollection(docs: any[], updates: Array<{ filter: any; update: any }> = []) {
  return {
    findOne: async (filter: any) => docs.find((d) => matches(d, filter)) ?? null,
    find: (filter: any) => ({
      toArray: async () => docs.filter((d) => matches(d, filter)),
      sort: () => ({ limit: () => ({ toArray: async () => docs.filter((d) => matches(d, filter)) }) }),
    }),
    updateOne: async (filter: any, update: any) => {
      updates.push({ filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (filter: any) => {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx >= 0) docs.splice(idx, 1);
      return { deletedCount: idx >= 0 ? 1 : 0 };
    },
    deleteMany: async (filter: any) => {
      const before = docs.length;
      for (let i = docs.length - 1; i >= 0; i--) {
        if (matches(docs[i], filter)) docs.splice(i, 1);
      }
      return { deletedCount: before - docs.length };
    },
    insertOne: async (doc: any) => {
      docs.push(doc);
      return { insertedId: doc.channelId ?? doc._id };
    },
    countDocuments: async (filter: any) => docs.filter((d) => matches(d, filter)).length,
    createIndex: async () => 'idx',
  };
}

function makeManager(fixture: Fixture) {
  const updates: Array<{ collection: string; filter: any; update: any }> = [];
  const stores: Record<string, any[]> = {
    channels: fixture.channels ?? [],
    workspaces: fixture.workspaces ?? [],
    channel_messages: fixture.messages ?? [],
    agent_configs: fixture.agentConfigs ?? [],
    users: fixture.users ?? [],
  };
  const db = {
    collection: (name: string) => {
      if (!stores[name]) stores[name] = [];
      const perCollection: Array<{ filter: any; update: any }> = [];
      const col = makeCollection(stores[name], perCollection);
      // Capturar updates con el nombre de la colección
      const origUpdate = col.updateOne;
      col.updateOne = async (filter: any, update: any) => {
        updates.push({ collection: name, filter, update });
        return origUpdate(filter, update);
      };
      return col;
    },
  } as any;

  const manager = new ChannelManager(db, {} as any);
  return { manager, stores, updates };
}

const WORKSPACE = {
  workspaceId: 'work_1',
  ownerId: 'user_owner',
  members: [{ userId: 'user_member', role: 'member' }],
  status: 'active',
};

const CHANNEL = {
  channelId: 'ch_1',
  userId: 'user_creator',
  agentId: 'agent_1',
  workspaceId: 'work_1',
  status: 'active',
  metadata: { name: 'Chat' },
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

// ─────────────────────────────────────────────────────────────────────────────
// canAccessChannel — las 4 ramas
// ─────────────────────────────────────────────────────────────────────────────

describe('ChannelManager.canAccessChannel', () => {
  it('grants access to the channel creator (userId match)', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_creator' as any)).toBe(true);
  });

  it('grants access to the assigned agent via agentId', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [] });
    expect(
      await manager.canAccessChannel('ch_1' as any, 'someone_else' as any, 'agent_1'),
    ).toBe(true);
  });

  it('a different agentId does NOT grant access', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [] });
    expect(
      await manager.canAccessChannel('ch_1' as any, 'someone_else' as any, 'agent_other'),
    ).toBe(false);
  });

  it('grants access to the workspace OWNER', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_owner' as any)).toBe(true);
  });

  it('grants access to a workspace MEMBER (dot-notation members.userId)', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_member' as any)).toBe(true);
  });

  it('denies access to a stranger (workspace-sovereign)', async () => {
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_stranger' as any)).toBe(false);
  });

  it('denies workspace access when the workspace is NOT active', async () => {
    const inactive = { ...WORKSPACE, status: 'archived' };
    const { manager } = makeManager({ channels: [CHANNEL], workspaces: [inactive] });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_owner' as any)).toBe(false);
  });

  it('returns false for a non-existent channel', async () => {
    const { manager } = makeManager({ channels: [], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_ghost' as any, 'user_owner' as any)).toBe(false);
  });

  it("grants an ADMIN access to their OWN synthetic MCA-test channel (no real record needed)", async () => {
    // The synthetic-channel path is the admin-gated app.test-mca-tool feature; the
    // caller must be a system admin (role admin|super) for the grant to apply.
    const { manager } = makeManager({
      channels: [],
      workspaces: [WORKSPACE],
      users: [{ userId: 'user_admin', role: 'admin' }],
    });
    expect(
      await manager.canAccessChannel('test-channel:user_admin' as any, 'user_admin' as any),
    ).toBe(true);
  });

  it("DENIES a non-admin caller their own synthetic test channel (authz-bypass regression)", async () => {
    // Without the admin gate, any authenticated user could forge
    // channelId='test-channel:<own id>' and be authorized against a channel that
    // never existed (→ orphan subscription writes in subscribe-to-events). A
    // non-admin must be denied even for their OWN synthetic id.
    const { manager } = makeManager({
      channels: [],
      workspaces: [WORKSPACE],
      users: [{ userId: 'user_alice', role: 'member' }],
    });
    expect(
      await manager.canAccessChannel('test-channel:user_alice' as any, 'user_alice' as any),
    ).toBe(false);
  });

  it("DENIES the synthetic path when the caller has no user record at all", async () => {
    const { manager } = makeManager({ channels: [], workspaces: [WORKSPACE] });
    expect(
      await manager.canAccessChannel('test-channel:user_ghost' as any, 'user_ghost' as any),
    ).toBe(false);
  });

  it("denies a synthetic test channel scoped to ANOTHER user (even for an admin)", async () => {
    const { manager } = makeManager({
      channels: [],
      workspaces: [WORKSPACE],
      users: [{ userId: 'user_admin', role: 'admin' }],
    });
    // A fabricated test-channel for someone else must NOT grant access to the caller.
    expect(
      await manager.canAccessChannel('test-channel:user_victim' as any, 'user_admin' as any),
    ).toBe(false);
  });

  it('channel without workspaceId: only the creator (or agent) can access', async () => {
    const orphan = { ...CHANNEL, channelId: 'ch_2', workspaceId: undefined };
    const { manager } = makeManager({ channels: [orphan], workspaces: [WORKSPACE] });
    expect(await manager.canAccessChannel('ch_2' as any, 'user_creator' as any)).toBe(true);
    expect(await manager.canAccessChannel('ch_2' as any, 'user_owner' as any)).toBe(false);
  });

  it('membership in ANOTHER workspace does not grant access to this channel', async () => {
    const otherWorkspace = {
      workspaceId: 'work_2',
      ownerId: 'user_other',
      members: [{ userId: 'user_member2', role: 'member' }],
      status: 'active',
    };
    const { manager } = makeManager({
      channels: [CHANNEL],
      workspaces: [WORKSPACE, otherWorkspace],
    });
    expect(await manager.canAccessChannel('ch_1' as any, 'user_member2' as any)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanupExpiredPrivateChannels
// ─────────────────────────────────────────────────────────────────────────────

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('ChannelManager.cleanupExpiredPrivateChannels', () => {
  it('deletes private channels inactive for >15 days, with their messages and config', async () => {
    const expired = {
      ...CHANNEL,
      channelId: 'ch_old',
      isPrivate: true,
      updatedAt: isoAgo(16),
    };
    const { manager, stores } = makeManager({
      channels: [expired],
      messages: [
        { messageId: 'm1', channelId: 'ch_old' },
        { messageId: 'm2', channelId: 'ch_old' },
        { messageId: 'm3', channelId: 'ch_other' },
      ],
      agentConfigs: [{ channelId: 'ch_old' }, { channelId: 'ch_other' }],
    });

    const deleted = await manager.cleanupExpiredPrivateChannels();

    expect(deleted).toBe(1);
    expect(stores.channels).toEqual([]);
    // Borrado en cascada: solo lo del canal expirado
    expect(stores.channel_messages.map((m) => m.messageId)).toEqual(['m3']);
    expect(stores.agent_configs).toEqual([{ channelId: 'ch_other' }]);
  });

  it('keeps private channels still inside the 15-day window', async () => {
    const fresh = { ...CHANNEL, channelId: 'ch_fresh', isPrivate: true, updatedAt: isoAgo(14) };
    const { manager, stores } = makeManager({ channels: [fresh] });

    expect(await manager.cleanupExpiredPrivateChannels()).toBe(0);
    expect(stores.channels.length).toBe(1);
  });

  it('NEVER touches non-private channels, no matter how old', async () => {
    const ancientPublic = { ...CHANNEL, channelId: 'ch_pub', updatedAt: isoAgo(100) };
    const { manager, stores } = makeManager({ channels: [ancientPublic] });

    expect(await manager.cleanupExpiredPrivateChannels()).toBe(0);
    expect(stores.channels.length).toBe(1);
  });

  it('deletes multiple expired channels and reports the exact count', async () => {
    const { manager, stores } = makeManager({
      channels: [
        { ...CHANNEL, channelId: 'ch_a', isPrivate: true, updatedAt: isoAgo(20) },
        { ...CHANNEL, channelId: 'ch_b', isPrivate: true, updatedAt: isoAgo(30) },
        { ...CHANNEL, channelId: 'ch_c', isPrivate: true, updatedAt: isoAgo(5) },
      ],
    });

    expect(await manager.cleanupExpiredPrivateChannels()).toBe(2);
    expect(stores.channels.map((c) => c.channelId)).toEqual(['ch_c']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setRunning
// ─────────────────────────────────────────────────────────────────────────────

describe('ChannelManager.setRunning', () => {
  it('running=true sets running flag AND records runningAt (exact update shape)', async () => {
    const { manager, updates } = makeManager({ channels: [CHANNEL] });
    await manager.setRunning('ch_1' as any, true);

    expect(updates.length).toBe(1);
    expect(updates[0].collection).toBe('channels');
    expect(updates[0].filter).toEqual({ channelId: 'ch_1' });
    expect(updates[0].update).toEqual({
      $set: { running: true, runningAt: expect.any(String) },
    });
    // runningAt es ISO válido
    const runningAt = updates[0].update.$set.runningAt;
    expect(new Date(runningAt).toISOString()).toBe(runningAt);
  });

  it('running=false clears the flag and $unsets runningAt (exact update shape)', async () => {
    const { manager, updates } = makeManager({ channels: [CHANNEL] });
    await manager.setRunning('ch_1' as any, false);

    expect(updates.length).toBe(1);
    expect(updates[0].update).toEqual({
      $set: { running: false },
      $unset: { runningAt: '' },
    });
  });
});
