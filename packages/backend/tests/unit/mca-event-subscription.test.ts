/**
 * MCAEventSubscriptionService — matching y dispatch (TER-456).
 *
 * Red de: topicMatches (wildcards), rulesMatch (OR entre objetos, AND
 * dentro, igualdad estricta), dispatch a channel subscriptions (collapse
 * wake>notify por canal, Capa 4 ownership de TER-358, turn_end+lastText,
 * sliding TTL) y agent subscriptions (correlación nueva/reusada).
 * 0 tests previos.
 */

import { describe, expect, it } from 'bun:test';
import { topicMatches } from '../../src/models/mca-event-subscriptions';
import { MCAEventSubscriptionService } from '../../src/services/mca-event-subscription-service';

// ─────────────────────────────────────────────────────────────────────────────
// topicMatches — función pura
// ─────────────────────────────────────────────────────────────────────────────

describe('topicMatches', () => {
  it('exact match', () => {
    expect(topicMatches('gmail.email.received', 'gmail.email.received')).toBe(true);
    expect(topicMatches('gmail.email.received', 'gmail.email.sent')).toBe(false);
  });

  it('"*" matches anything', () => {
    expect(topicMatches('*', 'whatever')).toBe(true);
    expect(topicMatches('*', '')).toBe(true);
  });

  it('"channel:*" matches the namespace prefix', () => {
    expect(topicMatches('channel:*', 'channel:turn_end')).toBe(true);
    expect(topicMatches('channel:*', 'channel:permission_request')).toBe(true);
    expect(topicMatches('channel:*', 'channels:other')).toBe(false);
    expect(topicMatches('channel:*', 'gmail.email.received')).toBe(false);
  });

  it('wildcard only applies with the ":*" suffix form', () => {
    // Un '*' en medio o sin ':' previo NO es wildcard.
    expect(topicMatches('gmail.*', 'gmail.email')).toBe(false);
    expect(topicMatches('*:end', 'turn:end')).toBe(false);
  });

  it('boundary: "channel:*" matches the bare prefix "channel:" itself', () => {
    expect(topicMatches('channel:*', 'channel:')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture de servicio con Db en memoria
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
  const updateManyCalls: Array<{ collection: string; filter: any; update: any }> = [];

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
      updateMany: async (filter: any, update: any) => {
        updateManyCalls.push({ collection: name, filter, update });
        return { modifiedCount: 0 };
      },
      createIndex: async () => 'idx',
    }),
  } as any;

  const service = new MCAEventSubscriptionService(db);

  const injected: any[] = [];
  service.setEventInjector(async (event) => {
    injected.push(event);
    return { success: true };
  });

  const wakes: any[] = [];
  service.setInjectTextAndWakeFn(async (params) => {
    wakes.push(params);
  });

  const createdChannels: Array<{ userId: string; agentId: string; metadata: any }> = [];
  let channelSeq = 0;
  service.setCreateChannelFn(async (userId, agentId, metadata) => {
    createdChannels.push({ userId, agentId, metadata });
    return { channelId: `ch_new_${++channelSeq}` };
  });

  service.setGetAgentUserIdFn(async (agentId) =>
    agentId === 'agent_orphan' ? null : `user_of_${agentId}`,
  );

  return { service, stores, updateManyCalls, injected, wakes, createdChannels };
}

const channelSub = (over: Partial<any> = {}) => ({
  id: over.id ?? 'sub_1',
  topic: over.topic ?? 'gmail.email.received',
  channelId: over.channelId ?? 'ch_1',
  rules: over.rules ?? [],
  mode: over.mode ?? 'notify',
  createdAt: new Date(),
  lastActivityAt: new Date(),
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch — channel subscriptions
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatch — channel subscriptions', () => {
  it('injects a system event into the matching channel with exact ScheduledEvent shape', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ mode: 'notify' })],
    });

    const result = await service.dispatch({
      topic: 'gmail.email.received',
      payload: { from: 'alice@x.com' },
    });

    expect(result).toEqual({ channelMatched: 1, agentMatched: 0 });
    expect(injected).toEqual([
      {
        channelId: 'ch_1',
        message: '[gmail.email.received] {"from":"alice@x.com"}',
        eventType: 'task_update',
        wakeUpAgent: false,
        metadata: { source: 'mca_event_subscription', from: 'alice@x.com' },
      },
    ]);
  });

  it('non-matching topic → no injection, count 0', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ topic: 'gmail.email.received' })],
    });
    const result = await service.dispatch({ topic: 'slack.message', payload: {} });
    expect(result.channelMatched).toBe(0);
    expect(injected).toEqual([]);
  });

  it('collapses multiple matching subs on the SAME channel into ONE injection, wake wins', async () => {
    const { service, injected } = makeService({
      channelSubs: [
        channelSub({ id: 'sub_a', topic: 'channel:*', mode: 'notify' }),
        channelSub({ id: 'sub_b', topic: 'channel:turn_start', mode: 'wake' }),
      ],
    });

    const result = await service.dispatch({ topic: 'channel:turn_start', payload: {} });

    expect(result.channelMatched).toBe(1); // 1 canal, no 2 subs
    expect(injected.length).toBe(1);
    expect(injected[0].wakeUpAgent).toBe(true); // wake > notify
    expect(injected[0].eventType).toBe('channel_started');
  });

  it('rules: OR across objects, AND within an object, strict equality', async () => {
    const { service, injected } = makeService({
      channelSubs: [
        channelSub({
          rules: [{ from: 'alice@x.com', starred: true }, { priority: 'high' }],
        }),
      ],
    });

    // Ningún rule object matchea completo
    await service.dispatch({
      topic: 'gmail.email.received',
      payload: { from: 'alice@x.com', starred: false },
    });
    expect(injected.length).toBe(0);

    // Segundo objeto matchea (OR)
    await service.dispatch({
      topic: 'gmail.email.received',
      payload: { priority: 'high' },
    });
    expect(injected.length).toBe(1);

    // Igualdad ESTRICTA: '1' !== 1
    await service.dispatch({
      topic: 'gmail.email.received',
      payload: { priority: 1 as any },
    });
    expect(injected.length).toBe(1);
  });

  it('sliding TTL: bumps lastActivityAt ONLY for the matched subscription ids', async () => {
    const { service, updateManyCalls } = makeService({
      channelSubs: [
        channelSub({ id: 'sub_match', topic: 'a:b' }),
        channelSub({ id: 'sub_other', topic: 'x:y', channelId: 'ch_2' }),
      ],
    });

    await service.dispatch({ topic: 'a:b', payload: {} });

    expect(updateManyCalls).toEqual([
      {
        collection: 'subscriptions_channel',
        filter: { id: { $in: ['sub_match'] } },
        update: { $set: { lastActivityAt: expect.any(Date) } },
      },
    ]);
  });

  it('channel:turn_end + wake + lastText → injects the TEXT (injectTextAndWake), not a system event', async () => {
    const { service, injected, wakes } = makeService({
      channelSubs: [channelSub({ topic: 'channel:turn_end', mode: 'wake' })],
    });

    await service.dispatch({
      topic: 'channel:turn_end',
      payload: { lastText: 'el subagente terminó esto', agentId: 'agent_sub' },
    });

    expect(injected).toEqual([]);
    expect(wakes).toEqual([
      { channelId: 'ch_1', text: 'el subagente terminó esto', senderAgentId: 'agent_sub' },
    ]);
  });

  it('turn_end with EMPTY lastText falls back to the system event path', async () => {
    const { service, injected, wakes } = makeService({
      channelSubs: [channelSub({ topic: 'channel:turn_end', mode: 'wake' })],
    });

    await service.dispatch({ topic: 'channel:turn_end', payload: { lastText: '   ' } });

    expect(wakes).toEqual([]);
    expect(injected.length).toBe(1);
    expect(injected[0].eventType).toBe('channel_finished');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capa 4 — ownership check (TER-358 defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatch — Capa 4 ownership', () => {
  it('payload.userId mismatch with channel owner → aborts that channel, others proceed', async () => {
    const { service, injected } = makeService({
      channelSubs: [
        channelSub({ id: 's1', channelId: 'ch_de_bob', topic: 'scheduler.reminder' }),
        channelSub({ id: 's2', channelId: 'ch_de_alice', topic: 'scheduler.reminder' }),
      ],
    });
    service.setGetChannelOwnerUserIdFn(async (channelId) =>
      channelId === 'ch_de_alice' ? 'user_alice' : 'user_bob',
    );

    await service.dispatch({
      topic: 'scheduler.reminder',
      payload: { userId: 'user_alice', message: 'ping' },
    });

    // Solo el canal cuyo owner coincide recibe la inyección.
    expect(injected.length).toBe(1);
    expect(injected[0].channelId).toBe('ch_de_alice');
    expect(injected[0].eventType).toBe('reminder');
    expect(injected[0].message).toBe('ping');
  });

  it('without resolver configured, the check is skipped (warn) and injection proceeds', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ topic: 'scheduler.reminder' })],
    });
    // NO setGetChannelOwnerUserIdFn

    await service.dispatch({
      topic: 'scheduler.reminder',
      payload: { userId: 'user_x', message: 'hola' },
    });
    expect(injected.length).toBe(1);
  });

  it('payload WITHOUT userId skips the ownership check entirely', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ topic: 'scheduler.reminder' })],
    });
    let resolverCalled = false;
    service.setGetChannelOwnerUserIdFn(async () => {
      resolverCalled = true;
      return 'whoever';
    });

    await service.dispatch({ topic: 'scheduler.reminder', payload: { message: 'x' } });

    expect(resolverCalled).toBe(false);
    expect(injected.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dispatch — agent subscriptions (correlación)
// ─────────────────────────────────────────────────────────────────────────────

const agentSub = (over: Partial<any> = {}) => ({
  id: over.id ?? 'asub_1',
  topic: over.topic ?? 'intercom.conversation.created',
  agentId: over.agentId ?? 'agent_1',
  rules: over.rules ?? [],
  correlationKey: over.correlationKey ?? 'clientId',
  createdAt: new Date(),
  ...over,
});

describe('dispatch — agent subscriptions', () => {
  it('new correlation value → creates channel, stores correlation, injects with wake', async () => {
    const { service, injected, createdChannels, stores } = makeService({
      agentSubs: [agentSub()],
    });

    const result = await service.dispatch({
      topic: 'intercom.conversation.created',
      payload: { clientId: 'client_42' },
    });

    expect(result.agentMatched).toBe(1);
    expect(createdChannels).toEqual([
      {
        userId: 'user_of_agent_1',
        agentId: 'agent_1',
        metadata: { name: 'Event: intercom.conversation.created' },
      },
    ]);
    expect(stores.subscriptions_correlation).toEqual([
      {
        id: expect.any(String),
        subscriptionId: 'asub_1',
        correlationValue: 'client_42',
        channelId: 'ch_new_1',
        createdAt: expect.any(Date),
      },
    ]);
    expect(injected.length).toBe(1);
    expect(injected[0].channelId).toBe('ch_new_1');
    expect(injected[0].wakeUpAgent).toBe(true); // agent subs SIEMPRE despiertan
  });

  it('existing correlation → reuses the channel without creating a new one', async () => {
    const { service, injected, createdChannels } = makeService({
      agentSubs: [agentSub()],
      correlations: [
        {
          id: 'cor_1',
          subscriptionId: 'asub_1',
          correlationValue: 'client_42',
          channelId: 'ch_existing',
          createdAt: new Date(),
        },
      ],
    });

    await service.dispatch({
      topic: 'intercom.conversation.created',
      payload: { clientId: 'client_42' },
    });

    expect(createdChannels).toEqual([]);
    expect(injected[0].channelId).toBe('ch_existing');
  });

  it('different correlation values map to different channels', async () => {
    const { service, injected } = makeService({ agentSubs: [agentSub()] });

    await service.dispatch({ topic: 'intercom.conversation.created', payload: { clientId: 'a' } });
    await service.dispatch({ topic: 'intercom.conversation.created', payload: { clientId: 'b' } });

    expect(injected.map((e) => e.channelId)).toEqual(['ch_new_1', 'ch_new_2']);
  });

  it('agent without resolvable userId → skipped without throwing', async () => {
    const { service, injected, createdChannels } = makeService({
      agentSubs: [agentSub({ agentId: 'agent_orphan' })],
    });

    const result = await service.dispatch({
      topic: 'intercom.conversation.created',
      payload: { clientId: 'x' },
    });

    expect(result.agentMatched).toBe(1); // matcheó, aunque la entrega fallara
    expect(createdChannels).toEqual([]);
    expect(injected).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// terminal_output — bypass de la DB
// ─────────────────────────────────────────────────────────────────────────────

describe('dispatch — terminal_output special case', () => {
  it('broadcasts directly to the terminal topic and skips subscriptions entirely', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ topic: '*' })], // ni el wildcard debe activarse
    });
    const broadcasts: Array<{ topic: string; payload: any }> = [];
    service.setPubSubService({
      broadcastToTopic: (topic: string, payload: any) => broadcasts.push({ topic, payload }),
    } as any);

    const result = await service.dispatch({
      topic: 'terminal_output',
      payload: { terminalId: 'term_1', data: 'ls\n', type: 'stdout' },
    });

    expect(result).toEqual({ channelMatched: 0, agentMatched: 0 });
    expect(injected).toEqual([]);
    expect(broadcasts).toEqual([
      {
        topic: 'terminal:term_1',
        payload: {
          type: 'terminal_output',
          data: 'ls\n',
          outputType: 'stdout',
          terminalId: 'term_1',
        },
      },
    ]);
  });
});

describe('dispatch — terminal_output without terminalId', () => {
  it('falls through to the normal subscription path (no broadcast to terminal:undefined)', async () => {
    const { service, injected } = makeService({
      channelSubs: [channelSub({ topic: '*' })],
    });
    const broadcasts: any[] = [];
    service.setPubSubService({
      broadcastToTopic: (topic: string, payload: any) => broadcasts.push({ topic, payload }),
    } as any);

    await service.dispatch({ topic: 'terminal_output', payload: { data: 'x' } });

    expect(broadcasts).toEqual([]);
    expect(injected.length).toBe(1); // lo capta la sub wildcard normal
  });
});

describe('dispatch — agent subscription with missing correlationKey', () => {
  it('correlates under the empty string, not the literal "undefined"', async () => {
    const { service, stores } = makeService({ agentSubs: [agentSub()] });

    await service.dispatch({
      topic: 'intercom.conversation.created',
      payload: { somethingElse: true }, // sin clientId
    });

    expect(stores.subscriptions_correlation.length).toBe(1);
    expect(stores.subscriptions_correlation[0].correlationValue).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEventMessage / mapTopicToEventType (vía el ScheduledEvent capturado)
// ─────────────────────────────────────────────────────────────────────────────

describe('event message and type mapping', () => {
  const cases: Array<{ topic: string; payload: any; message: string; eventType: string }> = [
    {
      topic: 'channel:turn_start',
      payload: { channelName: 'Mi chat' },
      message: 'Mi chat started',
      eventType: 'channel_started',
    },
    {
      topic: 'channel:turn_end',
      payload: { channelId: 'ch_9' },
      message: 'ch_9 finished',
      eventType: 'channel_finished',
    },
    {
      topic: 'scheduler.reminder',
      payload: { message: 'tómate el café' },
      message: 'tómate el café',
      eventType: 'reminder',
    },
    {
      topic: 'scheduler.recurring_task',
      payload: {},
      message: 'Recurring task',
      eventType: 'recurring_task',
    },
    {
      topic: 'channel:permission_request',
      payload: {},
      message: '[channel:permission_request] {}',
      eventType: 'channel_permission',
    },
    {
      topic: 'custom.mca.topic',
      payload: { a: 1 },
      message: '[custom.mca.topic] {"a":1}',
      eventType: 'task_update',
    },
  ];

  for (const c of cases) {
    it(`"${c.topic}" → message "${c.message}" / eventType "${c.eventType}"`, async () => {
      const { service, injected } = makeService({
        channelSubs: [channelSub({ topic: c.topic, mode: 'notify' })],
      });
      await service.dispatch({ topic: c.topic, payload: c.payload });
      expect(injected.length).toBe(1);
      expect(injected[0].message).toBe(c.message);
      expect(injected[0].eventType).toBe(c.eventType);
    });
  }
});
