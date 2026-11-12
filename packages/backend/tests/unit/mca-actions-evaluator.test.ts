/**
 * Unit tests — mca-actions/evaluator (Conversation Evaluator L2 backend).
 *
 * Task: task_db265dd9a4e8d376 (fase 3)
 *
 * Covers:
 *   - extract: single-model eligibility enforced server-side (multi-model → 422,
 *     no-usage → 422, missing channel → 404); metrics computed via the shared
 *     pure extractor.
 *   - conversation: windowing without overlap/gaps over real-shaped session
 *     docs; accumulated state echoed; windowIndex bounds.
 *   - record: expected doc shape with detectorLayer enforced per failure
 *     family (det codes stay det; BEH/OUT/USR… stay llm; mismatch rejected);
 *     intents validation (primary required, 'other' needs justification);
 *     outcome consistency (achieved + OUT-1 rejected); evidence mandatory.
 *
 * Db is fully mocked in-memory — no real MongoDB.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

// requireSystemAdmin reads the users collection: makeDb seeds ctx.userId as an
// admin. Never mock.module('auth-helpers') here — bun keeps module mocks for the
// rest of the run, which turned every later file's admin gate into a no-op.
import { evaluatorCapability } from '../../src/mca-actions/evaluator';

// ---------------------------------------------------------------------------
// In-memory Mongo mock (minimal surface used by the actions)
// ---------------------------------------------------------------------------

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => {
    const dv = k.split('.').reduce((acc: any, part) => acc?.[part], doc);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, ov]) => {
        if (op === '$gte') return dv >= ov;
        if (op === '$lte') return dv <= ov;
        return dv === ov;
      });
    }
    return dv === v;
  });
}

function makeCol(initial: Doc[] = []) {
  const docs = initial.map((d) => ({ ...d }));
  const col = {
    docs,
    find: (filter: Doc = {}) => ({
      project: (_p: Doc) => col.find(filter),
      sort: (_s: Doc) => col.find(filter),
      limit: (n: number) => ({ toArray: async () => docs.filter((d) => matches(d, filter)).slice(0, n) }),
      toArray: async () => docs.filter((d) => matches(d, filter)),
    }),
    findOne: async (filter: Doc) => docs.find((d) => matches(d, filter)) ?? null,
    createIndex: mock(async () => 'ok'),
    findOneAndUpdate: mock(async (filter: Doc, update: Doc, opts?: Doc) => {
      const idx = docs.findIndex((d) => matches(d, filter));
      const $set = update.$set ?? {};
      if (idx >= 0) {
        docs[idx] = { ...docs[idx], ...$set };
        return docs[idx];
      }
      if (opts?.upsert) {
        const seed: Doc = {};
        for (const [k, v] of Object.entries(filter)) {
          if (v === null || typeof v !== 'object') {
            // dot-path seeds (evaluator.promptVersion) — only channelId matters here
            if (!k.includes('.')) seed[k] = v;
          }
        }
        const created = { ...seed, ...(update.$setOnInsert ?? {}), ...$set };
        docs.push(created);
        return created;
      }
      return null;
    }),
  };
  return col;
}

function makeDb(collections: Record<string, Doc[]>) {
  const cols = new Map<string, ReturnType<typeof makeCol>>();
  const seeded = { users: [{ userId: 'user_admin', role: 'admin' }], ...collections };
  for (const [name, docs] of Object.entries(seeded)) cols.set(name, makeCol(docs));
  return {
    collection: (name: string) => {
      if (!cols.has(name)) cols.set(name, makeCol());
      return cols.get(name)!;
    },
    _cols: cols,
  } as any;
}

const ctx = { mcaId: 'mca.teros.admin.evaluator', userId: 'user_admin', appId: 'app_eval' };

// ---------------------------------------------------------------------------
// Fixture builders (real session_messages shape)
// ---------------------------------------------------------------------------

function sessDoc(id: string, role: string, created: number, parts: any[]) {
  return { sessionId: 'ch_test', info: { id, role, time: { created } }, parts };
}
function textPart(text: string) {
  return { id: `p_${Math.random()}`, type: 'text', text };
}
function toolPart(callID: string, tool: string, input: any, status = 'completed', output = 'ok') {
  return {
    id: `p_${callID}`,
    type: 'tool',
    tool,
    callID,
    state: { status, input, output, time: { start: 1, end: 2 } },
  };
}
function usageRow(modelId: string, withMessage = true) {
  return {
    channelId: 'ch_test',
    modelId,
    provider: 'test-provider',
    messageId: withMessage ? `m_${Math.random()}` : undefined,
    timestamp: new Date('2026-10-01T10:00:00Z'),
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costTotal: 0.001,
  };
}

function baseDb(usage: Doc[]) {
  return makeDb({
    channels: [{ channelId: 'ch_test', agentId: 'agent_x', userId: 'user_owner', metadata: { name: 'Test' } }],
    users: [
      { userId: 'user_admin', role: 'admin' },
      { userId: 'user_owner', consent: { evaluationOptIn: true } },
    ],
    llm_usage: usage,
    session_messages: [
      sessDoc('m1', 'user', 1000, [textPart('hola, analiza Instinct')]),
      sessDoc('m2', 'assistant', 2000, [textPart('voy a ello'), toolPart('c1', 'list-app-tools', { app: 'x' })]),
      sessDoc('m3', 'user', 3000, [textPart('gracias')]),
    ],
    channel_messages: [],
  });
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe('evaluator admin gate', () => {
  it('rejects a caller who is not a system admin', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    await expect(
      evaluatorCapability.actions.extract({ ...ctx, userId: 'user_plain' }, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('evaluator/extract', () => {
  it('returns L1 metrics for an eligible single-model conversation', async () => {
    const db = baseDb([usageRow('glm-5p2-fast'), usageRow('glm-5p2-fast')]);
    const res: any = await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' });
    expect(res.eligible).toBe(true);
    expect(res.modelId).toBe('glm-5p2-fast');
    expect(res.metrics.userMessages).toBe(2);
    expect(res.metrics.assistantMessages).toBe(1);
    expect(res.metrics.toolCallsTotal).toBe(1);
    expect(res.metrics.toolCallsCompleted).toBe(1);
  });

  it('rejects multi-model conversations server-side (strict rule)', async () => {
    const db = baseDb([usageRow('glm-5p2-fast'), usageRow('kimi-k3-fast')]);
    try {
      await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' });
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('INELIGIBLE');
      expect(e.message).toContain('ineligible_multi_model');
    }
  });

  it('rejects conversations with no llm_usage rows', async () => {
    const db = baseDb([]);
    try {
      await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('INELIGIBLE');
      expect(e.message).toContain('ineligible_no_usage');
    }
  });

  it('rejects unknown channels with NOT_FOUND', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    try {
      await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_missing' });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe('NOT_FOUND');
    }
  });

  it('ignores usage rows without messageId for the single-model rule', async () => {
    // a non-turn row (e.g. a title-generation call) with a different model must NOT exclude
    const rows = [usageRow('glm-5p2-fast'), { ...usageRow('title-model'), messageId: undefined }];
    const db = baseDb(rows);
    const res: any = await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' });
    expect(res.eligible).toBe(true);
    expect(res.modelId).toBe('glm-5p2-fast');
  });
});

// ---------------------------------------------------------------------------
// conversation (windowing)
// ---------------------------------------------------------------------------

describe('evaluator/conversation', () => {
  function bigDb(n: number) {
    const docs = [];
    for (let i = 0; i < n; i++) {
      docs.push(
        sessDoc(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 1000 + i, [
          textPart(`message ${i}`),
          ...(i % 3 === 0 ? [toolPart(`c${i}`, 'bash', { command: `cmd ${i}` }, 'completed', `output ${i}`)] : []),
        ]),
      );
    }
    return makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'agent_x', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' },
        { userId: 'user_owner', consent: { evaluationOptIn: true } },
      ],
      llm_usage: [usageRow('glm-5p2-fast')],
      session_messages: docs,
      channel_messages: [],
    });
  }

  it('windows cover the whole conversation with no overlap and no gaps', async () => {
    const db = bigDb(25);
    const size = 10;
    const seen = new Set<number>();
    let windowCount = 0;
    for (let w = 0; ; w++) {
      const res: any = await evaluatorCapability.actions.conversation(ctx, db, {
        channelId: 'ch_test',
        windowIndex: w,
        windowSize: size,
      });
      windowCount = res.windowCount;
      for (const m of res.messages) {
        expect(seen.has(m.index)).toBe(false);
        seen.add(m.index);
      }
      if (res.isLast) break;
    }
    expect(windowCount).toBe(3); // 25 msgs / 10 = 3 windows
    expect(seen.size).toBe(25);
  });

  it('echoes accumulated state through and validates it', async () => {
    const db = bigDb(5);
    const acc = {
      intents: [{ id: 'research_web', firstSeenMessageIndex: 0, primary: true }],
      failures: [{ code: 'BEH-4', severity: 'low', detectorLayer: 'llm', evidenceMessageIndexes: [1] }],
      featureRequests: [],
      notes: 'todo bien',
    };
    const res: any = await evaluatorCapability.actions.conversation(ctx, db, {
      channelId: 'ch_test',
      windowIndex: 1,
      windowSize: 3,
      accumulated: acc,
    });
    expect(res.accumulated).toEqual(acc);
    expect(res.isLast).toBe(true);
  });

  it('rejects out-of-range windowIndex and bad windowSize', async () => {
    const db = bigDb(5);
    await expect(
      evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test', windowIndex: 99, windowSize: 3 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test', windowSize: 0 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test', windowSize: 5000 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('renders tool parts with effective name, full input, status and output', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' },
        { userId: 'user_owner', consent: { evaluationOptIn: true } },
      ],
      llm_usage: [usageRow('m')],
      session_messages: [
        sessDoc('m1', 'assistant', 1000, [
          {
            id: 'p1',
            type: 'tool',
            tool: 'execute-tool',
            callID: 'call_1',
            state: {
              status: 'error',
              input: { app: 'bash', tool: 'bash', input: { command: 'ls' } },
              error: 'boom\nstack line 2',
              time: { start: 1, end: 2 },
            },
          },
        ]),
      ],
      channel_messages: [],
    });
    const res: any = await evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test' });
    const part = res.messages[0].parts[0];
    expect(part.kind).toBe('tool');
    expect(part.tool).toBe('bash/bash'); // unwrapped effective name
    expect(part.input).toEqual({ command: 'ls' }); // canonical inner input
    expect(part.status).toBe('error');
    expect(part.error).toBe('boom\nstack line 2'); // FULL error, not first line
  });

  it('applies single-model eligibility server-side', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' },
        { userId: 'user_owner', consent: { evaluationOptIn: true } },
      ],
      llm_usage: [usageRow('m1'), usageRow('m2')],
      session_messages: [sessDoc('m1', 'user', 1, [textPart('hi')])],
      channel_messages: [],
    });
    await expect(
      evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'INELIGIBLE' });
  });
});

// ---------------------------------------------------------------------------
// Consent gate — user opt-in, default OFF (task_047a4844b9103db3)
// ---------------------------------------------------------------------------

describe('evaluator consent gate (no_consent)', () => {
  const recordBody = {
    channelId: 'ch_test',
    scenarioFingerprint: 'fp_consent_1',
    scenario: { coreId: 'agent', flags: {}, attribution: 'reconstructed' },
    intents: [{ id: 'coding', primary: true }],
    outcome: 'achieved',
    failures: [],
    metrics: {},
  };

  it('rejects all three actions when the owner has not opted in — even for an admin caller', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' }, // caller IS admin — must not bypass
        { userId: 'user_owner' }, // no consent field → default OFF
      ],
      llm_usage: [usageRow('glm-5p2-fast')],
      session_messages: [sessDoc('m1', 'user', 1000, [textPart('hola')])],
      channel_messages: [],
    });
    await expect(
      evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT', status: 422 });
    await expect(
      evaluatorCapability.actions.conversation(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT', status: 422 });
    await expect(
      evaluatorCapability.actions.record(ctx, db, { ...recordBody }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT', status: 422 });
    // Nothing was written.
    expect(db._cols.get('conversation_evaluations')).toBeUndefined();
  });

  it('rejects when the owner explicitly opted out (flag false)', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' },
        { userId: 'user_owner', consent: { evaluationOptIn: false } },
      ],
      llm_usage: [usageRow('glm-5p2-fast')],
      session_messages: [sessDoc('m1', 'user', 1000, [textPart('hola')])],
      channel_messages: [],
    });
    await expect(
      evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT' });
  });

  it('rejects channels without an owner (cannot prove consent)', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a' }], // no userId
      users: [{ userId: 'user_admin', role: 'admin' }],
      llm_usage: [usageRow('glm-5p2-fast')],
      session_messages: [sessDoc('m1', 'user', 1000, [textPart('hola')])],
      channel_messages: [],
    });
    await expect(
      evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT' });
  });

  it('consent precedes eligibility: an ineligible conversation of a non-consenting owner reports no_consent first', async () => {
    const db = makeDb({
      channels: [{ channelId: 'ch_test', agentId: 'a', userId: 'user_owner' }],
      users: [
        { userId: 'user_admin', role: 'admin' },
        { userId: 'user_owner' }, // no consent
      ],
      llm_usage: [usageRow('m1'), usageRow('m2')], // multi-model → ineligible
      session_messages: [sessDoc('m1', 'user', 1, [textPart('hi')])],
      channel_messages: [],
    });
    await expect(
      evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' }),
    ).rejects.toMatchObject({ code: 'NO_CONSENT' }); // not INELIGIBLE
  });

  it('with opt-in ON the full flow works and content reaches the evaluator anonymized', async () => {
    const db = baseDb([usageRow('glm-5p2-fast'), usageRow('glm-5p2-fast')]);

    // extract
    const ext: any = await evaluatorCapability.actions.extract(ctx, db, { channelId: 'ch_test' });
    expect(ext.eligible).toBe(true);
    // The evaluator never sees the raw channelId (fase-4a anonymizer).
    expect(ext.channelId).not.toBe('ch_test');
    expect(typeof ext.channelId).toBe('string');

    // conversation window
    const win: any = await evaluatorCapability.actions.conversation(ctx, db, {
      channelId: 'ch_test',
      windowIndex: 0,
      windowSize: 10,
    });
    expect(win.channelId).not.toBe('ch_test');
    expect(win.messages.length).toBe(3);
    expect(win.isLast).toBe(true);

    // record — the record stores the RAW channelId (it is the platform-side
    // key), but the gate passed only because the owner opted in.
    const rec: any = await evaluatorCapability.actions.record(ctx, db, {
      ...recordBody,
      scenarioFingerprint: 'fp_consent_ok',
    });
    expect(rec.success).toBe(true);
    expect(db._cols.get('conversation_evaluations').docs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

describe('evaluator/record', () => {
  const validBody = {
    channelId: 'ch_test',
    scenarioFingerprint: 'fp_test_1',
    scenario: { coreId: 'agent', flags: { proxy: 'OFF' }, attribution: 'reconstructed' },
    intents: [
      { id: 'research_web', primary: true },
      { id: 'content_creation', primary: false },
    ],
    outcome: 'partial',
    failures: [
      {
        code: 'INE-1',
        severity: 'medium',
        confidence: 'high',
        evidence: { callIds: ['c1', 'c2'], tool: 'telegram/get-chats', detail: '15 pagination calls' },
      },
      {
        code: 'BEH-2',
        severity: 'high',
        confidence: 'medium',
        evidence: { messageIndexes: [10, 11, 12], detail: 'three loops without progress' },
      },
      {
        code: 'OUT-2',
        severity: 'high',
        confidence: 'high',
        evidence: { messageIndexes: [20] },
      },
    ],
    metrics: { toolCallsTotal: 79 },
    synthesis: 'Resumen de síntesis final.',
  };

  it('writes the record with detectorLayer enforced per family (det vs llm)', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const res: any = await evaluatorCapability.actions.record(ctx, db, { ...validBody });
    expect(res.success).toBe(true);
    expect(res.failuresRecorded).toBe(3);

    const stored = db._cols.get('conversation_evaluations').docs[0];
    expect(stored.channelId).toBe('ch_test');
    expect(stored.status).toBe('evaluated');
    expect(stored.scenarioFingerprint).toBe('fp_test_1');
    expect(stored.evaluator.promptVersion).toBeDefined();
    expect(stored.evaluator.taxonomyVersion).toContain('beh');
    // two-table separation
    const byCode = Object.fromEntries(stored.failures.map((f: any) => [f.code, f.detectorLayer]));
    expect(byCode['INE-1']).toBe('det'); // Tabla A — técnica
    expect(byCode['BEH-2']).toBe('llm'); // Tabla B — comportamiento
    expect(byCode['OUT-2']).toBe('llm');
    // intents: exactly one primary survived validation
    expect(stored.intents.filter((i: any) => i.primary).length).toBe(1);
    // fase 4b: tool name rides with det evidence (free tool x code table)
    const ine1: any = stored.failures.find((f: any) => f.code === 'INE-1');
    expect(ine1.evidence.tool).toBe('telegram/get-chats');
  });

  it('rejects a detectorLayer that contradicts the failure family', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const bad = {
      ...validBody,
      failures: [{ code: 'REP-1', severity: 'critical', detectorLayer: 'llm', evidence: { callIds: ['c1'] } }],
    };
    await expect(evaluatorCapability.actions.record(ctx, db, bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects failures without evidence (auditable or nothing)', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const bad = { ...validBody, failures: [{ code: 'BEH-1', severity: 'high' }] };
    await expect(evaluatorCapability.actions.record(ctx, db, bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects unknown failure codes (BEH-other is the escape hatch)', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const bad = {
      ...validBody,
      failures: [{ code: 'FOO-9', severity: 'low', evidence: { messageIndexes: [1] } }],
    };
    await expect(evaluatorCapability.actions.record(ctx, db, bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('requires exactly one primary intent', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const noPrimary = { ...validBody, intents: [{ id: 'coding', primary: false }] };
    await expect(evaluatorCapability.actions.record(ctx, db, noPrimary)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const twoPrimary = {
      ...validBody,
      intents: [
        { id: 'coding', primary: true },
        { id: 'devops', primary: true },
      ],
    };
    await expect(evaluatorCapability.actions.record(ctx, db, twoPrimary)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it("requires justification for intent 'other'", async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const bad = { ...validBody, intents: [{ id: 'other', primary: true }] };
    await expect(evaluatorCapability.actions.record(ctx, db, bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const good = { ...validBody, intents: [{ id: 'other', primary: true, justification: 'esotericism' }] };
    const res: any = await evaluatorCapability.actions.record(ctx, db, good);
    expect(res.success).toBe(true);
  });

  it("rejects outcome 'achieved' combined with OUT-1/OUT-2 (protocol consistency)", async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    const bad = { ...validBody, outcome: 'achieved' }; // still carries OUT-2
    await expect(evaluatorCapability.actions.record(ctx, db, bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('upserts: re-recording the same channel+promptVersion replaces the doc', async () => {
    const db = baseDb([usageRow('glm-5p2-fast')]);
    await evaluatorCapability.actions.record(ctx, db, { ...validBody });
    await evaluatorCapability.actions.record(ctx, db, { ...validBody, outcome: 'achieved', failures: [] });
    expect(db._cols.get('conversation_evaluations').docs.length).toBe(1);
    expect(db._cols.get('conversation_evaluations').docs[0].outcome).toBe('achieved');
  });

  it('applies single-model eligibility on record too', async () => {
    const db = baseDb([usageRow('m1'), usageRow('m2')]);
    await expect(evaluatorCapability.actions.record(ctx, db, { ...validBody })).rejects.toMatchObject({
      code: 'INELIGIBLE',
    });
  });
});
