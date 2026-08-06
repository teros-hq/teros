/**
 * Equivalence test: the server-side model-health merge (TER-668) must produce
 * BYTE-IDENTICAL summaries to the old all-in-JS `aggregateModelHealth` merge.
 *
 * Builds realistic rollup docs (via the real `buildModelHealthFromSessions`, so
 * the histograms/maps are exactly what production writes), runs BOTH paths, and
 * asserts the summaries are deep-equal — percentiles, bucket arrays, every rate,
 * and the status/error/finish maps. Integer latencies keep the sums exact, so a
 * single divergent bucket or a miscounted status turns this red.
 *
 * Ephemeral mongo (MONGODB_URI, default :27017) with a throwaway db. Skips if
 * Mongo is down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import type { AgentUsageSession } from '../../src/types/database';
import {
  aggregateModelHealth,
  aggregateModelHealthByHour,
  buildModelHealthFromSessions,
} from '../../src/services/model-health-aggregator';
import { buildModelHealthMergePipeline } from '../../src/services/model-health-merge-pipeline';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_mhmerge_${Date.now()}`;

let client: MongoClient;
let db: Db;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[model-health-merge test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

// Deterministic PRNG so the fixture is stable across runs.
let _s = 424242;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const MODELS = [
  { ap: 'fireworks', model: 'kimi-k2.6' },
  { ap: 'together', model: 'kimi-k2.6' },
  { ap: 'anthropic', model: 'claude-sonnet-4.5' },
  { ap: 'zhipu', model: 'glm-5.2' },
];
const STATUSES: AgentUsageSession['status'][] = ['completed', 'errored', 'timed_out', 'aborted'];
const ERRORS = ['rate_limited', 'overloaded', 'server_error', 'network_error'];
const FINISH = ['end_turn', 'tool_calls', 'max_tokens', 'length', 'stop', 'error'];

function mkSession(i: number, m: { ap: string; model: string }): AgentUsageSession {
  const status = STATUSES[Math.floor(rnd() * STATUSES.length)];
  // Latencies spanning several histogram buckets incl. the overflow (>81920ms).
  const latencyMs = Math.floor(rnd() * 90_000);
  const ttftMs = Math.floor(rnd() * 4_000);
  const outputTokens = rnd() < 0.15 ? 0 : Math.floor(rnd() * 500) + 1;
  const toolCallCount = Math.floor(rnd() * 4);
  return {
    sessionUsageId: `usess_${i}`,
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'u1',
    agentId: 'a1',
    workspaceId: 'w1',
    channelId: 'c1',
    provider: 'teros',
    modelId: m.model,
    actualModel: m.model,
    actualProvider: m.ap,
    startedAt: new Date(Date.UTC(2026, 5, 20, 10, 0, i % 60)),
    endedAt: new Date(Date.UTC(2026, 5, 20, 10, 0, (i % 60) + 1)),
    durationMs: latencyMs,
    durationSource: 'monotonic',
    status,
    errorKind: status === 'errored' ? (ERRORS[Math.floor(rnd() * ERRORS.length)] as any) : undefined,
    latencyMs,
    ttftMs,
    stopReason: FINISH[Math.floor(rnd() * FINISH.length)] as any,
    fallbackUsed: rnd() < 0.1,
    inputTokens: 100,
    outputTokens,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 100 + outputTokens,
    costUsd: 0,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount,
    toolErrorCount: toolCallCount > 0 && rnd() < 0.3 ? 1 : 0,
    usagePartial: rnd() < 0.1 ? true : undefined,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AgentUsageSession;
}

/** Build several rollup docs across a few hours, each with a real modelHealth block. */
function buildRollups() {
  const rollups: { hourBucket: Date; modelHealth: ReturnType<typeof buildModelHealthFromSessions> }[] = [];
  let i = 0;
  for (let hour = 8; hour <= 12; hour++) {
    // Multiple rollup docs per hour (different group keys) that share models —
    // exactly the fan-out the merge must collapse.
    for (let g = 0; g < 3; g++) {
      const sessions: AgentUsageSession[] = [];
      for (const m of MODELS) {
        const n = Math.floor(rnd() * 6) + 1;
        for (let k = 0; k < n; k++) sessions.push(mkSession(i++, m));
      }
      rollups.push({
        hourBucket: new Date(Date.UTC(2026, 5, 20, hour, 0, 0)),
        modelHealth: buildModelHealthFromSessions(sessions),
      });
    }
  }
  return rollups;
}

const MATCH = { hourBucket: { $gte: new Date(Date.UTC(2026, 5, 20, 0)), $lt: new Date(Date.UTC(2026, 5, 21, 0)) } };

describe('server-side model-health merge equivalence', () => {
  it('point-in-time merge equals the JS aggregateModelHealth', async () => {
    if (!available) return;
    const rollups = buildRollups();
    await db.collection('agent_usage_rollups_hourly').insertMany(rollups.map((r) => ({ ...r })));

    // JS path (old): merge all rollup slices in JS.
    const jsSummaries = aggregateModelHealth(rollups.map((r) => ({ modelHealth: r.modelHealth })));

    // Mongo path (new): $group merge → one entry per model → summarize.
    const merged = await db
      .collection('agent_usage_rollups_hourly')
      .aggregate(buildModelHealthMergePipeline(MATCH))
      .toArray();
    const mongoSlice = {
      modelHealth: Object.fromEntries(merged.map((e: any) => [`${e.actualProvider}::${e.modelId}`, e])),
    };
    const mongoSummaries = aggregateModelHealth([mongoSlice as any]);

    expect(mongoSummaries).toEqual(jsSummaries);
    // Sanity: the fixture actually exercised the models (not an empty pass).
    expect(mongoSummaries.length).toBe(MODELS.length);
    expect(mongoSummaries[0].latency.p95).not.toBeNull();
  });

  it('time-series (byHour) merge equals the JS aggregateModelHealthByHour', async () => {
    if (!available) return;
    const rollups = await db
      .collection('agent_usage_rollups_hourly')
      .find(MATCH, { projection: { hourBucket: 1, modelHealth: 1 } })
      .toArray();
    const jsSeries = aggregateModelHealthByHour(rollups as any);

    const mergedByHour = await db
      .collection('agent_usage_rollups_hourly')
      .aggregate(buildModelHealthMergePipeline(MATCH, { byHour: true }))
      .toArray();
    const byHour = new Map<number, Record<string, any>>();
    for (const e of mergedByHour as any[]) {
      const t = e.hourBucket.getTime();
      const m = byHour.get(t) ?? {};
      m[`${e.actualProvider}::${e.modelId}`] = e;
      byHour.set(t, m);
    }
    const slices = [...byHour.entries()].map(([t, modelHealth]) => ({ hourBucket: new Date(t), modelHealth }));
    const mongoSeries = aggregateModelHealthByHour(slices as any);

    expect(mongoSeries).toEqual(jsSeries);
  });

  it('returns a compact result (one doc per model, not one per rollup)', async () => {
    if (!available) return;
    const merged = await db
      .collection('agent_usage_rollups_hourly')
      .aggregate(buildModelHealthMergePipeline(MATCH))
      .toArray();
    // 15 rollup docs collapse to 4 model entries.
    expect(merged.length).toBe(MODELS.length);
  });
});
