/**
 * VoiceHandler — worker turn-event routing via MCAEventSubscriptionService.
 *
 * Covers the async callback chain of send-message / execute-tool:
 * registerWorkerChannel creates the turn_start/turn_end subscriptions targeting
 * the voice channel, the voice-channel listener injects the worker's result
 * into ElevenLabs on channel_finished and unregisters the worker, and cleanup
 * drops subscriptions of workers still in flight.
 * 0 tests previos del voice handler.
 */

import { describe, expect, it } from 'bun:test';
import { VoiceHandler } from '../../src/handlers/voice-handler';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

class FakeWs {
  readyState = 1; // OPEN
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  on() { /* not needed for these tests */ }
}

function makeFakeSubscriptionService() {
  const created: any[] = [];
  const deleted: string[] = [];
  let seq = 0;
  return {
    created,
    deleted,
    async createChannelSubscriptionsBatch(inputs: any[]) {
      const subs = inputs.map((input) => ({ id: `sub_${++seq}`, ...input }));
      created.push(...subs);
      return subs;
    },
    async deleteChannelSubscription(id: string) {
      deleted.push(id);
      return true;
    },
  };
}

function makeHandler(opts: { lastAssistantText?: string } = {}) {
  const subscriptionService = makeFakeSubscriptionService();
  const db = {
    collection: (name: string) => ({
      findOne: async () => {
        if (name === 'channel_messages' && opts.lastAssistantText !== undefined) {
          return { content: { type: 'text', text: opts.lastAssistantText } };
        }
        return null;
      },
      find: () => ({
        toArray: async () =>
          name === 'channel_messages' && opts.lastAssistantText !== undefined
            ? [{ role: 'assistant', content: { type: 'text', text: opts.lastAssistantText }, timestamp: '2026-07-04T14:00:00Z' }]
            : [],
      }),
      updateOne: async () => ({ modifiedCount: 1 }),
    }),
  };
  const channelManager = {
    createMessageId: () => `msg_${Math.random().toString(36).slice(2)}`,
    saveMessage: async () => {},
    getChannel: async () => null,
  };
  const listeners = new Map<string, Set<(raw: string) => void>>();
  const pubSubService = {
    addListener(channelId: string, listener: (raw: string) => void) {
      if (!listeners.has(channelId)) listeners.set(channelId, new Set());
      listeners.get(channelId)!.add(listener);
    },
    removeListener(channelId: string, listener: (raw: string) => void) {
      listeners.get(channelId)?.delete(listener);
    },
    broadcastToTopic() {},
  };
  const handler = new VoiceHandler(
    db as any,
    {} as any, // sessionManager — unused in these paths
    channelManager as any,
    {} as any, // secretsManager — unused in these paths
    {} as any, // messageHandler — unused in these paths
    subscriptionService as any,
    { validateSession: async () => ({ success: false }) } as any,
  );
  handler.setPubSubService(pubSubService as any);
  return { handler, subscriptionService, listeners };
}

function makeConnection() {
  return {
    clientWs: new FakeWs(),
    elevenLabsWs: new FakeWs(),
    userId: 'u1',
    workspaceId: 'ws1',
    voiceChannelId: 'ch_voice',
    chatChannelId: null,
    agentId: 'agent1',
    sessionId: 's1',
    activeWorkerChannels: new Map<string, string[]>(),
    channelReadsThisTurn: new Set<string>(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// registerWorkerChannel / unregisterWorkerChannel
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler worker subscriptions', () => {
  it('registerWorkerChannel creates turn_start + turn_end subs targeting the voice channel', async () => {
    const { handler, subscriptionService } = makeHandler();
    const conn = makeConnection();

    await (handler as any).registerWorkerChannel(conn, 'ch_worker');

    expect(subscriptionService.created).toHaveLength(2);
    const topics = subscriptionService.created.map((s) => s.topic).sort();
    expect(topics).toEqual(['channel:turn_end', 'channel:turn_start']);
    for (const sub of subscriptionService.created) {
      expect(sub.channelId).toBe('ch_voice'); // target = voice channel
      expect(sub.rules).toEqual([{ channelId: 'ch_worker' }]); // filter = worker
      expect(sub.mode).toBe('notify');
    }
    expect(conn.activeWorkerChannels.get('ch_worker')).toHaveLength(2);
  });

  it('registerWorkerChannel is idempotent per worker', async () => {
    const { handler, subscriptionService } = makeHandler();
    const conn = makeConnection();

    await (handler as any).registerWorkerChannel(conn, 'ch_worker');
    await (handler as any).registerWorkerChannel(conn, 'ch_worker');

    expect(subscriptionService.created).toHaveLength(2);
  });

  it('unregisterWorkerChannel deletes the subs and untracks the worker', async () => {
    const { handler, subscriptionService } = makeHandler();
    const conn = makeConnection();

    await (handler as any).registerWorkerChannel(conn, 'ch_worker');
    const subIds = [...conn.activeWorkerChannels.get('ch_worker')!];
    await (handler as any).unregisterWorkerChannel(conn, 'ch_worker');

    expect(conn.activeWorkerChannels.has('ch_worker')).toBe(false);
    expect(subscriptionService.deleted.sort()).toEqual(subIds.sort());
  });

  it('unregisterWorkerChannel is a no-op for untracked workers', async () => {
    const { handler, subscriptionService } = makeHandler();
    const conn = makeConnection();

    await (handler as any).unregisterWorkerChannel(conn, 'ch_unknown');

    expect(subscriptionService.deleted).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice-channel listener — channel_finished callback
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler channel_finished callback', () => {
  async function setupWithListener(lastAssistantText: string) {
    const { handler, subscriptionService, listeners } = makeHandler({ lastAssistantText });
    const conn = makeConnection();
    (handler as any).connections.set('conn1', conn);
    (handler as any).setupVoiceChannelListener('conn1');
    await (handler as any).registerWorkerChannel(conn, 'ch_worker');

    const fire = async (event: any) => {
      for (const listener of listeners.get('ch_voice') ?? []) {
        await listener(JSON.stringify({ type: 'event', event }));
      }
      // channel_finished handling is async — give injectAgentResult a tick
      await new Promise((r) => setTimeout(r, 0));
    };
    return { handler, subscriptionService, conn, fire };
  }

  it('injects the worker result into ElevenLabs and notifies the client', async () => {
    const { conn, fire } = await setupWithListener('Tienes 3 correos sin leer.');

    await fire({
      eventType: 'channel_finished',
      metadata: { observedChannelId: 'ch_worker', observedChannelName: 'Voice Task' },
    });

    const clientMsgs = (conn.clientWs as any).sent;
    expect(clientMsgs.some((m: any) => m.type === 'channel_event' && m.eventType === 'channel_finished')).toBe(true);
    expect(clientMsgs.some((m: any) => m.type === 'tool_result' && m.text === 'Tienes 3 correos sin leer.')).toBe(true);

    const elMsgs = (conn.elevenLabsWs as any).sent;
    const contextual = elMsgs.find((m: any) => m.type === 'contextual_update');
    expect(contextual.text).toContain('Tienes 3 correos sin leer.');
    const wake = elMsgs.find((m: any) => m.type === 'user_message');
    expect(wake.text).toBe('[event] agent_response_ready channel_id=ch_worker');
  });

  it('unregisters the worker when it finishes', async () => {
    const { subscriptionService, conn, fire } = await setupWithListener('done');

    await fire({
      eventType: 'channel_finished',
      metadata: { observedChannelId: 'ch_worker', observedChannelName: 'Voice Task' },
    });

    expect(conn.activeWorkerChannels.has('ch_worker')).toBe(false);
    expect(subscriptionService.deleted).toHaveLength(2);
  });

  it('truncates long results in the contextual_update sent to ElevenLabs', async () => {
    const longText = 'x'.repeat(5000);
    const { conn, fire } = await setupWithListener(longText);

    await fire({
      eventType: 'channel_finished',
      metadata: { observedChannelId: 'ch_worker', observedChannelName: 'Voice Task' },
    });

    const contextual = (conn.elevenLabsWs as any).sent.find((m: any) => m.type === 'contextual_update');
    expect(contextual.text).toContain('[truncated]');
    expect(contextual.text.length).toBeLessThan(2000);
    // The client still gets the full text
    const toolResult = (conn.clientWs as any).sent.find((m: any) => m.type === 'tool_result');
    expect(toolResult.text).toBe(longText);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// get-channel-messages — one progress read per user turn for active workers
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler get-channel-messages poll backstop', () => {
  it('allows one read per turn for an active worker, refuses repeats, re-arms on user turn', async () => {
    const { handler } = makeHandler({ lastAssistantText: 'progress so far' });
    const conn = makeConnection();
    (handler as any).connections.set('conn1', conn);
    await (handler as any).registerWorkerChannel(conn, 'ch_worker');

    const elSent = (conn.elevenLabsWs as any).sent;
    const lastResult = () => JSON.parse(elSent[elSent.length - 1].result);

    // 1st read of the turn → real messages, status processing
    await (handler as any).handleGetChannelMessages('conn1', 'tc1', { channel_id: 'ch_worker' });
    expect(lastResult().status).toBe('processing');
    expect(lastResult().message_count).toBe(1);

    // 2nd read same turn → refused, no messages
    await (handler as any).handleGetChannelMessages('conn1', 'tc2', { channel_id: 'ch_worker' });
    expect(lastResult().message_count).toBeUndefined();
    expect(lastResult().message).toContain('already checked this turn');

    // user speaks → allowance re-armed (this is what user_transcript does)
    conn.channelReadsThisTurn.clear();
    await (handler as any).handleGetChannelMessages('conn1', 'tc3', { channel_id: 'ch_worker' });
    expect(lastResult().message_count).toBe(1);
  });

  it('reads of finished channels are unrestricted and marked completed', async () => {
    const { handler } = makeHandler({ lastAssistantText: 'final answer' });
    const conn = makeConnection();
    (handler as any).connections.set('conn1', conn);

    await (handler as any).handleGetChannelMessages('conn1', 'tc1', { channel_id: 'ch_done' });
    await (handler as any).handleGetChannelMessages('conn1', 'tc2', { channel_id: 'ch_done' });

    const elSent = (conn.elevenLabsWs as any).sent;
    for (const msg of elSent) {
      const r = JSON.parse(msg.result);
      expect(r.status).toBe('completed');
      expect(r.message_count).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanup — drops in-flight worker subscriptions
// ─────────────────────────────────────────────────────────────────────────────

describe('VoiceHandler cleanup', () => {
  it('deletes subscriptions of workers still in flight', async () => {
    const { handler, subscriptionService } = makeHandler();
    const conn = makeConnection();
    (handler as any).connections.set('conn1', conn);
    (handler as any).setupVoiceChannelListener('conn1');
    await (handler as any).registerWorkerChannel(conn, 'ch_worker_a');
    await (handler as any).registerWorkerChannel(conn, 'ch_worker_b');

    (handler as any).cleanup('conn1');
    await new Promise((r) => setTimeout(r, 0)); // unregister is fire-and-forget

    expect(subscriptionService.deleted).toHaveLength(4);
    expect((handler as any).connections.has('conn1')).toBe(false);
  });
});
