/**
 * Integration test: session-detail PII super-gate + access audit-log (TER-671).
 *
 * The trace exposes cross-tenant conversation text. This pins the enforced
 * behavior against real Mongo:
 *   - a NON-super admin gets the trace with `text: null` (structure intact);
 *   - a super gets the plaintext;
 *   - a non-admin is rejected FORBIDDEN and reads nothing;
 *   - every successful read leaves exactly one append-only audit record with the
 *     right role + textIncluded flag (ledger-first).
 *
 * Ephemeral mongo (MONGODB_URI, default :27017), throwaway db. Skips if down.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { type Db, MongoClient } from 'mongodb';
import { createAgentUsageSessionDetailHandler } from '../../src/handlers/domains/admin-api/agent-usage';
import { recordSessionDetailAccess } from '../../src/services/agent-usage-access-log';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_piigate_${Date.now()}`;

let client: MongoClient;
let db: Db;
let available = false;

const ctx = (userId: string) =>
  ({ userId, connectionId: 'c', sessionId: 's' }) as WsHandlerContext;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[pii-gate test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

beforeEach(async () => {
  if (!available) return;
  await Promise.all([
    db.collection('users').deleteMany({}),
    db.collection('agent_usage_sessions').deleteMany({}),
    db.collection('llm_usage').deleteMany({}),
    db.collection('channel_messages').deleteMany({}),
    db.collection('agent_usage_access_log').deleteMany({}),
  ]);
  await db.collection('users').insertMany([
    { userId: 'u_super', role: 'super' },
    { userId: 'u_admin', role: 'admin' },
    { userId: 'u_plain', role: 'user' },
  ]);
  await db.collection('agent_usage_sessions').insertOne({
    sessionUsageId: 'su_1',
    userId: 'owner',
    agentId: 'ag_1',
    status: 'completed',
  });
  await db.collection('llm_usage').insertOne({
    usageId: 'usage_1',
    sessionUsageId: 'su_1',
    messageId: 'msg_a',
    step: 0,
    timestamp: new Date('2026-06-30T10:00:00Z'),
    provider: 'teros',
    modelId: 'kimi',
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costTotal: 0,
  });
  await db.collection('channel_messages').insertOne({
    messageId: 'msg_a',
    role: 'assistant',
    content: { type: 'text', text: 'SECRET partner conversation' },
    timestamp: '2026-06-30T10:00:01.000Z',
  });
});

function firstLlmText(trace: any): string | null {
  const ev = trace.events.find((e: any) => e.kind === 'llm');
  return ev?.llm?.message?.text ?? null;
}

describe('session-detail PII gate', () => {
  it('super sees the plaintext + audit records textIncluded:true', async () => {
    if (!available) return;
    const handler = createAgentUsageSessionDetailHandler(db);
    const trace = await handler(ctx('u_super'), { sessionUsageId: 'su_1' });
    expect(firstLlmText(trace)).toBe('SECRET partner conversation');
    const logs = await db.collection('agent_usage_access_log').find({}).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].adminUserId).toBe('u_super');
    expect(logs[0].role).toBe('super');
    expect(logs[0].sessionUsageId).toBe('su_1');
    expect(logs[0].textIncluded).toBe(true);
  });

  it('non-super admin gets text:null but the structure + an audit record (textIncluded:false)', async () => {
    if (!available) return;
    const handler = createAgentUsageSessionDetailHandler(db);
    const trace = await handler(ctx('u_admin'), { sessionUsageId: 'su_1' });
    expect(firstLlmText(trace)).toBeNull();
    // Structure the admin still sees.
    const ev = trace.events.find((e: any) => e.kind === 'llm');
    expect(ev.llm.message.contentType).toBe('text');
    expect(ev.llm.totalTokens).toBe(15);
    const logs = await db.collection('agent_usage_access_log').find({}).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].role).toBe('admin');
    expect(logs[0].textIncluded).toBe(false);
  });

  it('a non-admin is rejected FORBIDDEN and leaves no audit record and no read', async () => {
    if (!available) return;
    const handler = createAgentUsageSessionDetailHandler(db);
    let code: string | undefined;
    try {
      await handler(ctx('u_plain'), { sessionUsageId: 'su_1' });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('FORBIDDEN');
    expect(await db.collection('agent_usage_access_log').countDocuments({})).toBe(0);
  });
});

describe('recordSessionDetailAccess — ledger-first failure propagation', () => {
  it('throws when the audit insert fails (no unaudited access)', async () => {
    const brokenDb = {
      collection: () => ({
        insertOne: async () => {
          throw new Error('mongo down');
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: targeted fake
    } as any;
    let threw = false;
    try {
      await recordSessionDetailAccess(brokenDb, {
        adminUserId: 'u_admin',
        role: 'admin',
        sessionUsageId: 'su_1',
        textIncluded: false,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
