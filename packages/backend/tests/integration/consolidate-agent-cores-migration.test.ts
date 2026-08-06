/**
 * Integration test: 20260529_001_consolidate_agent_cores migration.
 *
 * Runs the migration against a throwaway database on the local Mongo instance
 * and verifies: two internal cores created, agents remapped by scope, legacy
 * cores deactivated, idempotency on re-run, and rollback via down().
 *
 * Uses the ephemeral test MongoDB (MONGODB_URI, default :27019 — see
 * scripts/test-integration.sh). Never touches the shared :27017 instance.
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { type Db, MongoClient } from 'mongodb';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import migration from '../../src/migrations/20260529_001_consolidate_agent_cores';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const DB_NAME = `teros_test_cores_${Date.now()}`;

// The per-core base prompts the migration seeds. Read straight from source so
// the test asserts the exact payload, not a brittle keyword.
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/prompts');
const AGENT_PROMPT = readFileSync(join(PROMPTS_DIR, 'base-agent-core.md'), 'utf-8');
const SUPER_AGENT_PROMPT = readFileSync(join(PROMPTS_DIR, 'base-super-agent-core.md'), 'utf-8');

let client: MongoClient;
let db: Db;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[migration test] Mongo unreachable — skipping');
    return;
  }

  await db.collection('agent_cores').insertMany([
    { coreId: 'alice', name: 'Alice', status: 'active' },
    { coreId: 'iria', name: 'Iria', status: 'active' },
  ]);
  await db.collection('agents').insertMany([
    { agentId: 'agent_global', coreId: 'iria', ownerId: 'u1', status: 'active' },
    {
      agentId: 'agent_ws',
      coreId: 'alice',
      ownerId: 'u1',
      workspaceId: 'work_1',
      status: 'active',
    },
    // Legacy agent predating the required `status` field (no status at all).
    { agentId: 'agent_nostatus', coreId: 'iria', ownerId: 'u1' },
    // Explicitly disabled agent — its status must be preserved, not clobbered.
    {
      agentId: 'agent_disabled',
      coreId: 'alice',
      ownerId: 'u1',
      workspaceId: 'work_1',
      status: 'inactive',
    },
    // Empty-string workspaceId (falsy) — must classify as super-agent to agree
    // with resolveCoreType, NOT as a workspace agent.
    { agentId: 'agent_emptyws', coreId: 'iria', ownerId: 'u1', workspaceId: '', status: 'active' },
  ]);
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

describe('consolidate_agent_cores migration', () => {
  it('up: creates two internal cores, remaps agents by scope, deactivates legacy', async () => {
    if (!available) return;
    await migration.up(db);

    const agentCore = await db.collection('agent_cores').findOne({ coreId: 'agent' });
    const superCore = await db.collection('agent_cores').findOne({ coreId: 'super-agent' });
    expect(agentCore?.coreType).toBe('agent');
    expect(agentCore?.status).toBe('active');
    expect(superCore?.coreType).toBe('super-agent');
    expect(superCore?.defaultApps).toContain('mca.teros.core');

    // Each core carries its OWN base system prompt (the heart of MOTOR vs
    // PERSONALITY): the workspace `agent` and the global `super-agent` must NOT
    // share a prompt. Assert the exact payload each got, and that the two source
    // prompts genuinely differ (guards against both files collapsing to one).
    expect(AGENT_PROMPT).not.toBe(SUPER_AGENT_PROMPT);
    expect(agentCore?.systemPrompt).toBe(AGENT_PROMPT);
    expect(superCore?.systemPrompt).toBe(SUPER_AGENT_PROMPT);

    const globalAgent = await db.collection('agents').findOne({ agentId: 'agent_global' });
    const wsAgent = await db.collection('agents').findOne({ agentId: 'agent_ws' });
    expect(globalAgent?.coreId).toBe('super-agent'); // global → super-agent
    expect(wsAgent?.coreId).toBe('agent'); // workspace → agent

    // Empty-string workspaceId is falsy → super-agent (agrees with resolveCoreType).
    const emptyWs = await db.collection('agents').findOne({ agentId: 'agent_emptyws' });
    expect(emptyWs?.coreId).toBe('super-agent');

    const alice = await db.collection('agent_cores').findOne({ coreId: 'alice' });
    expect(alice?.status).toBe('inactive');
  });

  it('up: backfills the required status field on legacy agents, preserving explicit values', async () => {
    if (!available) return;
    // Agent that had no status → backfilled to 'active'.
    const noStatus = await db.collection('agents').findOne({ agentId: 'agent_nostatus' });
    expect(noStatus?.status).toBe('active');
    expect(noStatus?.coreId).toBe('super-agent'); // global → super-agent
    // Agent explicitly 'inactive' → preserved, never clobbered.
    const disabled = await db.collection('agents').findOne({ agentId: 'agent_disabled' });
    expect(disabled?.status).toBe('inactive');
    expect(disabled?.coreId).toBe('agent'); // workspace → agent
    // No agent is left without the required field.
    expect(await db.collection('agents').countDocuments({ status: { $exists: false } })).toBe(0);
  });

  it('up: is idempotent (no duplicate cores on re-run)', async () => {
    if (!available) return;
    await migration.up(db);
    const count = await db.collection('agent_cores').countDocuments({ coreId: 'agent' });
    expect(count).toBe(1);
    const globalAgent = await db.collection('agents').findOne({ agentId: 'agent_global' });
    expect(globalAgent?.coreId).toBe('super-agent');
  });

  it('down: refuses while agents still reference the internal cores (anti-orphan guard)', async () => {
    if (!available) return;
    // After up(), every seeded agent points at 'agent'/'super-agent'. Deleting
    // those cores now would orphan them, so down() must throw instead.
    expect(await db.collection('agents').countDocuments({ coreId: { $in: ['agent', 'super-agent'] } })).toBeGreaterThan(0);
    await expect(migration.down(db)).rejects.toThrow(/Refusing down/);
    // Cores untouched — nothing was deleted.
    expect(await db.collection('agent_cores').findOne({ coreId: 'agent' })).not.toBeNull();
  });

  it('down: reactivates legacy cores and removes the internal cores once no agent references them', async () => {
    if (!available) return;
    // Re-point every agent away from the internal cores (what a real rollback
    // would do first), then down() is safe.
    await db.collection('agents').updateMany(
      { coreId: { $in: ['agent', 'super-agent'] } },
      { $set: { coreId: 'alice' } },
    );
    await migration.down(db);
    expect(await db.collection('agent_cores').findOne({ coreId: 'agent' })).toBeNull();
    expect(await db.collection('agent_cores').findOne({ coreId: 'super-agent' })).toBeNull();
    const alice = await db.collection('agent_cores').findOne({ coreId: 'alice' });
    expect(alice?.status).toBe('active');
  });
});
