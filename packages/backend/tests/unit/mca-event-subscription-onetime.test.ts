/**
 * One-time subscriptions (VOICE-NOTIFY-1 / P1 del spec voice-events).
 *
 * Spec: docs/specs/20261018_voice-events.md §3.4. A subscription with
 * oneTime: true delivers ONCE and is atomically deleted (claim-and-delete
 * BEFORE delivery: deleteOne({id, oneTime:true}) is the claim — the loser of
 * the race must not deliver). Permanent subscriptions are never touched.
 * A one-time sub that does not match must survive.
 */

import { describe, expect, it } from 'bun:test';
import { MCAEventSubscriptionService } from '../../src/services/mca-event-subscription-service';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture de servicio con Db en memoria (misma forma que mca-event-subscription.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface SubFixture {
  channelSubs?: any[];
  agentSubs?: any[];
  correlations?: any[];
}

function makeService(fixture: SubFixture = {}) {
  const stores: Record<string, any[]> = {
    subscriptions_channel: fixture.channelSubs ?? [],
    subscriptions_agent: fixture.agentSubs ?? [],
    subscriptions_correlation: fixture.correlations ?? [],
  };

  const db = {
    collection: (name: string) => ({
      find: (_filter: any) => ({ toArray: async () => [...(stores[name] ?? [])] }),
      findOne: async (filter: any) =>
        (stores[name] ?? []).find((d) =>
          Object.entries(filter).every(([k, v]) => d[k] === v),
        ) ?? null,
      insertOne: async (doc: any) => {
        (stores[name] ??= []).push(doc);
        return { insertedId: doc.id };
      },
      deleteOne: async (filter: any) => {
        const arr = stores[name] ?? [];
        const idx = arr.findIndex((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
        if (idx >= 0) arr.splice(idx, 1);
        return { deletedCount: idx >= 0 ? 1 : 0 };
      },
      deleteMany: async () => ({ deletedCount: 0 }),
      updateMany: async () => ({ modifiedCount: 0 }),
      createIndex: async () => 'idx',
    }),
  } as any;

  const service = new MCAEventSubscriptionService(db);

  const injected: any[] = [];
  service.setEventInjector(async (event) => {
    injected.push(event);
    return { success: true };
  });

  service.setInjectTextAndWakeFn(async () => {});

  let channelSeq = 0;
  service.setCreateChannelFn(async () => ({ channelId: `ch_new_${++channelSeq}` }));
  service.setGetAgentUserIdFn(async (agentId) => `user_of_${agentId}`);

  return { service, stores, injected };
}

const channelSub = (over: Partial<any> = {}) => ({
  id: over.id ?? 'sub_1',
  topic: over.topic ?? 'elevenlabs.post_call_transcription',
  channelId: over.channelId ?? 'ch_1',
  rules: over.rules ?? [],
  mode: over.mode ?? 'notify',
  createdAt: new Date(),
  lastActivityAt: new Date(),
  ...over,
});

const agentSub = (over: Partial<any> = {}) => ({
  id: over.id ?? 'asub_1',
  topic: over.topic ?? 'elevenlabs.post_call_transcription',
  agentId: over.agentId ?? 'agent_1',
  rules: over.rules ?? [],
  correlationKey: over.correlationKey ?? 'conversationId',
  createdAt: new Date(),
  ...over,
});

const POST_CALL_PAYLOAD = {
  type: 'post_call_transcription',
  data: { conversation_id: 'conv_abc', status: 'done' },
  conversationId: 'conv_abc', // flat alias added by the webhook handler (P2)
};

// ─────────────────────────────────────────────────────────────────────────────
// VOICE-NOTIFY-1 fix: post-call wake + readable message (spec §3.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('post_call: wake mode + readable message', () => {
  const FLAT_POST_CALL = {
    ...POST_CALL_PAYLOAD,
    transcriptSummary: 'Van el miércoles 21 a Oviedo',
    callSuccessful: true,
    durationSecs: 134,
    terminationReason: 'interrupt',
  };

  it('wake-mode subscription injects wakeUpAgent=true (agent must answer)', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'wake' })],
    });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: FLAT_POST_CALL });
    expect(injected).toHaveLength(1);
    expect(injected[0].wakeUpAgent).toBe(true);
  });

  it('message is a readable one-liner, NOT a JSON dump', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'wake' })],
    });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: FLAT_POST_CALL });
    expect(injected).toHaveLength(1);
    expect(injected[0].message).toBe('Van el miércoles 21 a Oviedo (call successful, 134s)');
    expect(injected[0].message).not.toContain('JSON');
    expect(injected[0].message).not.toContain('{');
  });

  it('eventType is voice.post_call (not the generic task_update)', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'wake' })],
    });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: FLAT_POST_CALL });
    expect(injected[0].eventType).toBe('voice.post_call');
  });

  it('unsuccessful call without summary falls back to a readable line', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'wake' })],
    });
    await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: { ...FLAT_POST_CALL, callSuccessful: false, transcriptSummary: '' },
    });
    expect(injected[0].message).toBe('Call ended unsuccessfully — interrupt (134s)');
  });

  it('notify-mode subscription still injects (no wake) with the readable message', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'notify' })],
    });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: FLAT_POST_CALL });
    expect(injected).toHaveLength(1);
    expect(injected[0].wakeUpAgent).toBe(false);
    expect(injected[0].message).toBe('Van el miércoles 21 a Oviedo (call successful, 134s)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel one-time subscriptions
// ─────────────────────────────────────────────────────────────────────────────

describe('one-time channel subscriptions', () => {
  it('delivers once and auto-deletes after the match', async () => {
    const { service, stores, injected } = makeService({
      channelSubs: [channelSub({ id: 'sub_ot', oneTime: true, rules: [{ conversationId: 'conv_abc' }] })],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    expect(result.channelMatched).toBe(1);
    expect(injected).toHaveLength(1);
    expect(injected[0].channelId).toBe('ch_1');
    // The subscription is gone after delivering.
    expect(stores.subscriptions_channel).toHaveLength(0);

    // A second identical event finds nothing: no double delivery.
    const second = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });
    expect(second.channelMatched).toBe(0);
    expect(injected).toHaveLength(1);
  });

  it('permanent subscriptions are never deleted', async () => {
    const { service, stores, injected } = makeService({
      channelSubs: [channelSub({ id: 'sub_perm', oneTime: false })],
    });

    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });

    expect(stores.subscriptions_channel).toHaveLength(1);
    expect(stores.subscriptions_channel[0].id).toBe('sub_perm');
    expect(injected).toHaveLength(2);
  });

  it('one-time that does NOT match is not deleted (rules mismatch)', async () => {
    const { service, stores, injected } = makeService({
      channelSubs: [channelSub({ id: 'sub_ot', oneTime: true, rules: [{ conversationId: 'conv_OTHER' }] })],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    expect(result.channelMatched).toBe(0);
    expect(injected).toHaveLength(0);
    expect(stores.subscriptions_channel).toHaveLength(1);
    expect(stores.subscriptions_channel[0].id).toBe('sub_ot');
  });

  it('one-time that does NOT match is not deleted (topic mismatch)', async () => {
    const { service, stores } = makeService({
      channelSubs: [channelSub({ id: 'sub_ot', oneTime: true, topic: 'gmail.email.received' })],
    });

    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });

    expect(stores.subscriptions_channel).toHaveLength(1);
    expect(stores.subscriptions_channel[0].id).toBe('sub_ot');
  });

  it('one-time + permanent on the same channel → ONE injection, permanent survives', async () => {
    const { service, stores, injected } = makeService({
      channelSubs: [
        channelSub({ id: 'sub_ot', oneTime: true, mode: 'notify' }),
        channelSub({ id: 'sub_perm', mode: 'wake' }),
      ],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    // Collapse wake > notify per channel: one injection with wake semantics.
    expect(result.channelMatched).toBe(1);
    expect(injected).toHaveLength(1);
    expect(injected[0].wakeUpAgent).toBe(true);
    // The one-time was consumed; the permanent stays.
    expect(stores.subscriptions_channel.map((s) => s.id)).toEqual(['sub_perm']);
  });

  it('two one-time subs on DIFFERENT channels both deliver and both are deleted', async () => {
    const { service, stores, injected } = makeService({
      channelSubs: [
        channelSub({ id: 'sub_a', channelId: 'ch_a', oneTime: true }),
        channelSub({ id: 'sub_b', channelId: 'ch_b', oneTime: true }),
      ],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    expect(result.channelMatched).toBe(2);
    expect(injected.map((e) => e.channelId).sort()).toEqual(['ch_a', 'ch_b']);
    expect(stores.subscriptions_channel).toHaveLength(0);
  });

  it('documents the race guard: a permanent sub is NOT claimable by deleteOne({id, oneTime:true})', async () => {
    // The dispatcher claims with deleteOne({ id, oneTime: true }). In MongoDB
    // this can only match documents with oneTime: true, so a permanent sub can
    // never be claimed by a concurrent dispatch. The in-memory mock follows the
    // same semantics (field equality), which this test pins.
    const { service, stores, injected } = makeService({
      channelSubs: [channelSub({ id: 'sub_perm' })], // no oneTime key at all (legacy doc)
    });

    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });

    // Delivered (as ongoing) and still present.
    expect(injected).toHaveLength(1);
    expect(stores.subscriptions_channel).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent one-time subscriptions
// ─────────────────────────────────────────────────────────────────────────────

describe('one-time agent subscriptions', () => {
  it('delivers once (creates correlation channel) and auto-deletes', async () => {
    const { service, stores, injected } = makeService({
      agentSubs: [agentSub({ id: 'asub_ot', oneTime: true, rules: [{ conversationId: 'conv_abc' }] })],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    expect(result.agentMatched).toBe(1);
    expect(injected).toHaveLength(1);
    expect(stores.subscriptions_agent).toHaveLength(0);

    const second = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });
    expect(second.agentMatched).toBe(0);
    expect(injected).toHaveLength(1);
  });

  it('permanent agent subscriptions are never deleted', async () => {
    const { service, stores, injected } = makeService({
      agentSubs: [agentSub({ id: 'asub_perm', oneTime: false })],
    });

    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });
    await service.dispatch({ topic: 'elevenlabs.post_call_transcription', payload: POST_CALL_PAYLOAD });

    expect(stores.subscriptions_agent).toHaveLength(1);
    expect(stores.subscriptions_agent[0].id).toBe('asub_perm');
    expect(injected).toHaveLength(2);
  });

  it('one-time agent sub that does NOT match is not deleted', async () => {
    const { service, stores, injected } = makeService({
      agentSubs: [agentSub({ id: 'asub_ot', oneTime: true, rules: [{ conversationId: 'conv_OTHER' }] })],
    });

    const result = await service.dispatch({
      topic: 'elevenlabs.post_call_transcription',
      payload: POST_CALL_PAYLOAD,
    });

    expect(result.agentMatched).toBe(0);
    expect(injected).toHaveLength(0);
    expect(stores.subscriptions_agent).toHaveLength(1);
    expect(stores.subscriptions_agent[0].id).toBe('asub_ot');
  });
});
