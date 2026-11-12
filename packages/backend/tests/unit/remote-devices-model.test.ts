/**
 * MongoRemoteDeviceRegistry — structural guards on the update documents.
 *
 * Bug T-REM-FIX-1 (2026-10-18): upsertOnline put `name` in BOTH `$set` and
 * `$setOnInsert`. Real Mongo rejects that with
 *   MongoServerError: Updating the path 'name' would create a conflict at 'name'
 * and the gateway's onHello catch swallowed it, leaving remote_devices stale
 * forever. The gateway suite uses an in-memory fake registry, so nothing
 * caught it.
 *
 * These tests intercept the driver's findOneAndUpdate/updateOne calls and
 * assert the generic invariant: no path may appear in more than one update
 * operator ($set / $setOnInsert / $unset / $inc / $push / ...). That catches
 * this whole class of bug for every method of the registry, without needing
 * a live Mongo.
 */

import { describe, expect, it } from 'bun:test';
import type { Collection, Db } from 'mongodb';
import {
  MongoRemoteDeviceRegistry,
  type RemoteDeviceOnlineInput,
} from '../../src/models/remote-devices';

const SAMPLE_INPUT: RemoteDeviceOnlineInput = {
  deviceId: 'dev_test_1',
  ownerId: 'user_1',
  workspaceId: 'work_1',
  appId: 'app_1',
  tokenHash: 'a'.repeat(64),
  sessionId: 'rsess_1',
  hostname: 'raw',
  name: 'raw',
  os: 'linux',
  arch: 'x64',
  daemonVersion: '0.1.0',
  declaredAllowedRoots: ['/srv'],
  execEnabled: true,
  capabilities: ['bash'],
};

/** Collect the top-level paths touched by each update operator. */
function operatorPaths(update: Record<string, unknown>): Map<string, string[]> {
  const byOp = new Map<string, string[]>();
  for (const [op, body] of Object.entries(update)) {
    if (!op.startsWith('$') || typeof body !== 'object' || body === null) continue;
    byOp.set(op, Object.keys(body as Record<string, unknown>));
  }
  return byOp;
}

/** Paths present in more than one operator — Mongo rejects these updates. */
function conflictingPaths(update: Record<string, unknown>): string[] {
  const seen = new Map<string, string>(); // root path -> first operator
  const conflicts = new Set<string>();
  for (const [op, paths] of operatorPaths(update)) {
    for (const p of paths) {
      const root = p.split('.')[0];
      const prev = seen.get(root);
      if (prev && prev !== op) conflicts.add(`${root} (${prev} + ${op})`);
      else if (!prev) seen.set(root, op);
    }
  }
  return [...conflicts];
}

/** Build a registry whose collection records the update doc instead of hitting Mongo. */
function spyRegistry() {
  const calls: { method: string; filter: unknown; update: Record<string, unknown> }[] = [];
  const col = {
    findOneAndUpdate: async (filter: unknown, update: Record<string, unknown>) => {
      calls.push({ method: 'findOneAndUpdate', filter, update });
      return { ...SAMPLE_INPUT, status: 'online', createdAt: new Date(), updatedAt: new Date() };
    },
    updateOne: async (filter: unknown, update: Record<string, unknown>) => {
      calls.push({ method: 'updateOne', filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    },
  } as unknown as Collection;
  const db = { collection: () => col } as unknown as Db;
  return { registry: new MongoRemoteDeviceRegistry(db), calls };
}

describe('MongoRemoteDeviceRegistry — update document structure', () => {
  it('upsertOnline: no path appears in more than one update operator ($set vs $setOnInsert conflict)', async () => {
    const { registry, calls } = spyRegistry();
    await registry.upsertOnline(SAMPLE_INPUT);

    expect(calls).toHaveLength(1);
    const { update } = calls[0];
    expect(update.$set).toBeDefined();
    expect(update.$setOnInsert).toBeDefined();
    expect(conflictingPaths(update)).toEqual([]);
  });

  it('upsertOnline: $setOnInsert only carries insert-only fields (deviceId, createdAt, lastUserActivityAt)', async () => {
    const { registry, calls } = spyRegistry();
    await registry.upsertOnline(SAMPLE_INPUT);

    const onInsert = Object.keys(calls[0].update.$setOnInsert as Record<string, unknown>).sort();
    // v1.1.0 keep-alive/TTL: lastUserActivityAt is insert-only on purpose — a
    // reconnect stamps activity on FIRST insert only; on an existing record the
    // keepalive service owns the field (a fresher stored activity must not be
    // clobbered by $set on every hello).
    expect(onInsert).toEqual(['createdAt', 'deviceId', 'lastUserActivityAt']);
    // name must still be written on every hello (rename propagation) via $set
    const set = calls[0].update.$set as Record<string, unknown>;
    expect(set.name).toBe(SAMPLE_INPUT.name);
    // v1.1.0: a reconnect clears any previous backend-ordered stop
    expect(calls[0].update.$unset).toEqual({ stoppedAt: '', stoppedReason: '' });
  });

  it('markOffline: no overlapping operator paths', async () => {
    const { registry, calls } = spyRegistry();
    await registry.markOffline('dev_test_1', 'rsess_1');
    expect(conflictingPaths(calls[0].update)).toEqual([]);
  });

  it('touch (with and without lastError): no overlapping operator paths', async () => {
    const { registry, calls } = spyRegistry();
    await registry.touch('dev_test_1');
    await registry.touch('dev_test_1', { lastError: 'boom' });
    await registry.touch('dev_test_1', { lastError: null });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(conflictingPaths(c.update)).toEqual([]);
    // lastError omitted entirely when patch doesn't mention it
    expect((calls[0].update.$set as Record<string, unknown>).lastError).toBeUndefined();
    expect((calls[1].update.$set as Record<string, unknown>).lastError).toBe('boom');
    expect((calls[2].update.$set as Record<string, unknown>).lastError).toBeNull();
  });
});
