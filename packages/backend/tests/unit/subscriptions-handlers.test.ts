/**
 * WS subscriptions handlers — contract-boundary (TER-481, grupo admin/resto).
 *
 * mca.subscribe/unsubscribe/list-event-subscriptions enrutan eventos MCA a un
 * canal. Authz: canAccessChannel del canal objetivo (subscribe/list) o del canal
 * de la suscripción (unsubscribe, vía lookup en 'subscriptions_channel'). Cubre
 * los gates + payload exacto + casos NOT_FOUND. Handlers mockeados (no Mongo).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createSubscribeToEventsHandler } from '../../src/handlers/domains/subscriptions/subscribe-to-events';
import { createUnsubscribeFromEventsHandler } from '../../src/handlers/domains/subscriptions/unsubscribe-from-events';
import { createListEventSubscriptionsHandler } from '../../src/handlers/domains/subscriptions/list-event-subscriptions';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

function makeChannelManager(allowedChannel: string | null) {
  return {
    canAccessChannel: mock(async (channelId: string, _userId: string) => channelId === allowedChannel),
  } as any;
}

const SUB = {
  id: 'sub_1',
  topic: 'github.push',
  channelId: 'ch_1',
  rules: [{ k: 'v' }],
  mode: 'notify' as const,
  createdAt: '2026-01-01',
  lastActivityAt: '2026-01-02',
};

function makeSubService(over: any = {}) {
  return {
    createChannelSubscription: mock(async () => SUB),
    deleteChannelSubscription: mock(async () => true),
    listChannelSubscriptions: mock(async () => [SUB]),
    ...over,
  } as any;
}

/** db con 'subscriptions_channel' para unsubscribe lookup. */
function makeDb(sub: any) {
  return { collection: () => ({ findOne: async () => sub }) } as any;
}

// ---------------------------------------------------------------------------
// subscribe-to-events
// ---------------------------------------------------------------------------

describe('mca.subscribe-to-events', () => {
  it('MISSING_FIELDS sin topic / sin channelId', async () => {
    const h = createSubscribeToEventsHandler(makeSubService(), makeChannelManager('ch_1'));
    await expect(h(ctx('u1'), { channelId: 'ch_1' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('u1'), { topic: 't' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('FORBIDDEN si no tiene acceso al canal y NO crea', async () => {
    const svc = makeSubService();
    const h = createSubscribeToEventsHandler(svc, makeChannelManager(null));
    await expect(h(ctx('u1'), { topic: 't', channelId: 'ch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.createChannelSubscription).not.toHaveBeenCalled();
  });

  it('happy: crea con defaults (rules=[], mode=notify) y payload exacto', async () => {
    const svc = makeSubService();
    const h = createSubscribeToEventsHandler(svc, makeChannelManager('ch_1'));
    const res = await h(ctx('u1'), { topic: 'github.push', channelId: 'ch_1' });
    expect(svc.createChannelSubscription).toHaveBeenCalledWith({
      topic: 'github.push', channelId: 'ch_1', rules: [], mode: 'notify',
    });
    expect(res).toEqual({
      subscription: { id: 'sub_1', topic: 'github.push', channelId: 'ch_1', rules: [{ k: 'v' }], mode: 'notify', createdAt: '2026-01-01' },
    });
  });

  it('respeta rules y mode provistos', async () => {
    const svc = makeSubService();
    const h = createSubscribeToEventsHandler(svc, makeChannelManager('ch_1'));
    await h(ctx('u1'), { topic: 't', channelId: 'ch_1', rules: [{ a: 1 }], mode: 'wake' });
    expect(svc.createChannelSubscription).toHaveBeenCalledWith({ topic: 't', channelId: 'ch_1', rules: [{ a: 1 }], mode: 'wake' });
  });
});

// ---------------------------------------------------------------------------
// unsubscribe-from-events
// ---------------------------------------------------------------------------

describe('mca.unsubscribe-from-events', () => {
  it('MISSING_FIELDS sin id', async () => {
    const h = createUnsubscribeFromEventsHandler(makeSubService(), makeChannelManager('ch_1'), makeDb(SUB));
    await expect(h(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('NOT_FOUND si la suscripción no existe', async () => {
    const h = createUnsubscribeFromEventsHandler(makeSubService(), makeChannelManager('ch_1'), makeDb(null));
    await expect(h(ctx('u1'), { id: 'sub_x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('FORBIDDEN si no tiene acceso al canal de la suscripción y NO borra', async () => {
    const svc = makeSubService();
    const h = createUnsubscribeFromEventsHandler(svc, makeChannelManager(null), makeDb(SUB));
    await expect(h(ctx('u1'), { id: 'sub_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.deleteChannelSubscription).not.toHaveBeenCalled();
  });

  it('NOT_FOUND si deleteChannelSubscription devuelve false', async () => {
    const svc = makeSubService({ deleteChannelSubscription: mock(async () => false) });
    const h = createUnsubscribeFromEventsHandler(svc, makeChannelManager('ch_1'), makeDb(SUB));
    await expect(h(ctx('u1'), { id: 'sub_1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('happy: {deleted:true}', async () => {
    const svc = makeSubService();
    const h = createUnsubscribeFromEventsHandler(svc, makeChannelManager('ch_1'), makeDb(SUB));
    const res = await h(ctx('u1'), { id: 'sub_1' });
    expect(res).toEqual({ deleted: true });
    expect(svc.deleteChannelSubscription).toHaveBeenCalledWith('sub_1');
  });
});

// ---------------------------------------------------------------------------
// list-event-subscriptions
// ---------------------------------------------------------------------------

describe('mca.list-event-subscriptions', () => {
  it('MISSING_FIELDS sin channelId', async () => {
    const h = createListEventSubscriptionsHandler(makeSubService(), makeChannelManager('ch_1'));
    await expect(h(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('FORBIDDEN si no tiene acceso al canal', async () => {
    const svc = makeSubService();
    const h = createListEventSubscriptionsHandler(svc, makeChannelManager(null));
    await expect(h(ctx('u1'), { channelId: 'ch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.listChannelSubscriptions).not.toHaveBeenCalled();
  });

  it('happy: payload exacto incluye lastActivityAt', async () => {
    const h = createListEventSubscriptionsHandler(makeSubService(), makeChannelManager('ch_1'));
    const res = await h(ctx('u1'), { channelId: 'ch_1' });
    expect(res).toEqual({
      subscriptions: [{
        id: 'sub_1', topic: 'github.push', channelId: 'ch_1', rules: [{ k: 'v' }], mode: 'notify',
        createdAt: '2026-01-01', lastActivityAt: '2026-01-02',
      }],
    });
  });
});
