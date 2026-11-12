/**
 * Auto-subscribe del canal iniciador (VOICE-NOTIFY-1 / P2 del spec
 * voice-events §3.3 + §3.5).
 *
 * Fija el contrato de subscribeInitiatorChannelToPostCall: suscripción
 * one-time de canal con filtro conversationId al llamar; opt-out con
 * notifyChannel:false; llamadas sin canal iniciador (inbound/API) o sin
 * conversation_id no crean nada; fallo del backend es best-effort (nunca
 * rompe la tool call).
 */

import { readFileSync } from 'fs';
import { describe, expect, it } from 'bun:test';
import {
  POST_CALL_TOPIC,
  buildPostCallSubscriptionRules,
  subscribeInitiatorChannelToPostCall,
} from '../src/notify';

describe('buildPostCallSubscriptionRules', () => {
  it('filters by conversationId at top level (the backend flattens the payload)', () => {
    expect(buildPostCallSubscriptionRules('conv_abc')).toEqual([{ conversationId: 'conv_abc' }]);
  });
});

describe('subscribeInitiatorChannelToPostCall', () => {
  it('creates a one-time channel subscription scoped to this conversation', async () => {
    const calls: any[] = [];
    const backend = {
      createChannelSubscription: async (params: any) => {
        calls.push(params);
        return { success: true, subscription: { id: 'sub_123', topic: params.topic, channelId: params.channelId, mode: params.mode } };
      },
    };

    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: true,
      conversationId: 'conv_abc',
      initiatorChannelId: 'ch_initiator',
    });

    expect(out).toEqual({ subscribed: true, subscriptionId: 'sub_123' });
    expect(calls).toEqual([
      {
        topic: POST_CALL_TOPIC,
        mode: 'wake',
        rules: [{ conversationId: 'conv_abc' }],
        channelId: 'ch_initiator',
        oneTime: true,
      },
    ]);
  });

  it('notifyChannel:false → no subscription (fire-and-forget opt-out)', async () => {
    const calls: any[] = [];
    const backend = {
      createChannelSubscription: async (params: any) => {
        calls.push(params);
        return { success: true, subscription: { id: 'sub_x' } };
      },
    };

    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: false,
      conversationId: 'conv_abc',
      initiatorChannelId: 'ch_initiator',
    });

    expect(out).toEqual({ subscribed: false, reason: 'notifyChannel_disabled' });
    expect(calls).toHaveLength(0);
  });

  it('no initiator channel (inbound / API call) → no subscription', async () => {
    const calls: any[] = [];
    const backend = {
      createChannelSubscription: async (params: any) => {
        calls.push(params);
        return { success: true, subscription: { id: 'sub_x' } };
      },
    };

    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: true,
      conversationId: 'conv_abc',
      initiatorChannelId: null,
    });

    expect(out).toEqual({ subscribed: false, reason: 'no_initiator_channel' });
    expect(calls).toHaveLength(0);
  });

  it('no conversation_id → no subscription (a wildcard one-time would swallow any call)', async () => {
    const calls: any[] = [];
    const backend = {
      createChannelSubscription: async (params: any) => {
        calls.push(params);
        return { success: true, subscription: { id: 'sub_x' } };
      },
    };

    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: true,
      conversationId: null,
      initiatorChannelId: 'ch_initiator',
    });

    expect(out).toEqual({ subscribed: false, reason: 'no_conversation_id' });
    expect(calls).toHaveLength(0);
  });

  it('backend unavailable → best-effort no-op, never throws', async () => {
    const out = await subscribeInitiatorChannelToPostCall({
      backend: undefined,
      notifyChannel: true,
      conversationId: 'conv_abc',
      initiatorChannelId: 'ch_initiator',
    });
    expect(out).toEqual({ subscribed: false, reason: 'backend_unavailable' });
  });

  it('backend rejection → subscription_error, never throws', async () => {
    const backend = {
      createChannelSubscription: async () => ({ success: false }),
    };
    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: true,
      conversationId: 'conv_abc',
      initiatorChannelId: 'ch_initiator',
    });
    expect(out.subscribed).toBe(false);
    expect(out.reason).toBe('subscription_error');
  });

  it('backend throw → subscription_error, never throws (the call must not fail)', async () => {
    const backend = {
      createChannelSubscription: async () => {
        throw new Error('network down');
      },
    };
    const out = await subscribeInitiatorChannelToPostCall({
      backend,
      notifyChannel: true,
      conversationId: 'conv_abc',
      initiatorChannelId: 'ch_initiator',
    });
    expect(out.subscribed).toBe(false);
    expect(out.reason).toBe('subscription_error');
    expect(out.errorMessage).toContain('network down');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift guard: el wiring de outbound-call (misma idea que events-payload.test.ts)
// El handler vive dentro de server.tool() en index.ts, que arranca el server al
// importarse — no es importable en tests. Este pin de fuente garantiza que la
// tool sigue pasando notifyChannel + canal iniciador al helper y exponiendo el
// resultado. Si alguien reescribe el handler y desconecta el auto-subscribe,
// este test falla.
// ─────────────────────────────────────────────────────────────────────────────

describe('outbound-call wiring (source pin)', () => {
  const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('declares the notifyChannel parameter', () => {
    expect(indexSrc).toContain("notifyChannel: { type: 'boolean'");
  });

  it('passes args.notifyChannel and the initiator channel to the helper', () => {
    expect(indexSrc).toContain('subscribeInitiatorChannelToPostCall({');
    expect(indexSrc).toContain('notifyChannel: args.notifyChannel');
    expect(indexSrc).toContain('initiatorChannelId: (context as any).execution?.channelId ?? null');
  });

  it('surfaces the outcome in the tool result', () => {
    expect(indexSrc).toContain('notifyChannel,');
  });
});
