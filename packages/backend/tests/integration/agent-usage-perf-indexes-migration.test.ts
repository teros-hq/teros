/**
 * Integration test: 20260708_002_agent_usage_perf_indexes migration (TER-667).
 *
 * Runs the migration against a throwaway database and verifies the additive
 * indexes exist, that the dashboard's hot queries switch from a blocking SORT
 * over a COLLSCAN to an IXSCAN, that the migration is idempotent, that the
 * agents.agentId unique index is enforced (with a non-unique fallback on dupes),
 * and that down() removes them.
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards — never touches real collections. Skips silently if Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import migration from '../../src/migrations/20260708_002_agent_usage_perf_indexes';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_perfidx_${Date.now()}`;

let client: MongoClient;
let db: Db;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[perf-index migration test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

/** All stage names in an explain winningPlan tree (recursive). */
function planStages(plan: any): string[] {
  if (!plan) return [];
  const out: string[] = [];
  if (plan.stage) out.push(plan.stage);
  if (plan.inputStage) out.push(...planStages(plan.inputStage));
  for (const s of plan.inputStages ?? []) out.push(...planStages(s));
  return out;
}

async function indexNames(col: string): Promise<string[]> {
  return (await db.collection(col).indexes()).map((i) => i.name as string);
}

describe('20260708_002 perf indexes', () => {
  it('creates the additive indexes and re-runs idempotently', async () => {
    if (!available) return;
    await db.collection('agent_usage_sessions').insertOne({ sessionUsageId: 's1', startedAt: new Date() });
    await db.collection('tool_executions').insertOne({ toolExecutionId: 't1', workspaceId: 'w1', startedAt: new Date() });
    await db.collection('agents').insertMany([{ agentId: 'agent_a' }, { agentId: 'agent_b' }]);

    await migration.up(db);
    await migration.up(db); // idempotent: a second run must not throw

    expect(await indexNames('agent_usage_sessions')).toContain('startedAt_desc');
    const tool = await indexNames('tool_executions');
    expect(tool).toContain('startedAt_desc');
    expect(tool).toContain('workspace_startedAt');
    expect(await indexNames('agents')).toContain('agentId_unique');
    expect(await indexNames('message_feedback')).toContain('createdAt_asc');
  });

  it('serves the default sort-by-startedAt query from the index (no blocking SORT)', async () => {
    if (!available) return;
    const explain = await db
      .collection('agent_usage_sessions')
      .find({})
      .sort({ startedAt: -1 })
      .explain('queryPlanner');
    const stages = planStages(explain.queryPlanner.winningPlan);
    // Before the index: COLLSCAN + a blocking in-memory SORT. After: IXSCAN, no SORT.
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('SORT');
  });

  it('serves tool_executions filtered by workspaceId from an index', async () => {
    if (!available) return;
    const explain = await db
      .collection('tool_executions')
      .find({ workspaceId: 'w1' })
      .sort({ startedAt: -1 })
      .explain('queryPlanner');
    const stages = planStages(explain.queryPlanner.winningPlan);
    expect(stages).toContain('IXSCAN');
    expect(stages).not.toContain('COLLSCAN');
  });

  it('enforces agentId uniqueness after the migration', async () => {
    if (!available) return;
    let threw = false;
    try {
      await db.collection('agents').insertOne({ agentId: 'agent_a' }); // dup
    } catch (err) {
      threw = (err as { code?: number }).code === 11000;
    }
    expect(threw).toBe(true);
  });

  it('falls back to a non-unique agents index when legacy dupes exist (no boot crash)', async () => {
    if (!available) return;
    const dupDb = client.db(`${DB_NAME}_dup`);
    await dupDb.collection('agents').insertMany([{ agentId: 'x' }, { agentId: 'x' }]);
    // Must NOT throw despite the duplicate.
    await migration.up(dupDb);
    const names = (await dupDb.collection('agents').indexes()).map((i) => i.name);
    expect(names).toContain('agentId_idx'); // non-unique fallback
    expect(names).not.toContain('agentId_unique');
    await dupDb.dropDatabase();
  });

  it('down() drops the added indexes', async () => {
    if (!available) return;
    await migration.down(db);
    const s = await indexNames('agent_usage_sessions');
    expect(s).not.toContain('startedAt_desc');
    expect(await indexNames('agents')).not.toContain('agentId_unique');
  });
});
