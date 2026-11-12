/**
 * Voice Mode v2 — Fase 0 tests (spec v1.1.0, REQ-2 + REQ-6, AC-2 parcial).
 *
 * Covers the F0 single-channel collapse:
 *
 *  1. `handleConnection` channel resolution (REQ-2):
 *     - rejects with `channel_required` when no chatChannelId / existingChannelId
 *       is provided (no orphan "Voice Conversation" channels are ever created).
 *     - rejects with `channel_unavailable` when the channel does not exist or
 *       belongs to another user.
 *
 *  2. `saveTranscript` single-write (dual-write eliminated, AC-2):
 *     - one transcript line → exactly ONE channel_messages write, to the
 *       conversation channel, with source:'voice'.
 *
 *  3. `voice_sessions` persistence (REQ-6):
 *     - upsert on connect: one record per (channelId, agentId), presence 'on',
 *       canonical mode (legacy active→'conversation', silent→'passive').
 *     - touch on activity (lastActivityAt + mode).
 *     - close on cleanup (presence 'off', record kept).
 *     - loadPersistedVoiceMode restores the canonical mode.
 *
 *  4. Permission verbal notification preserved in the single-channel model:
 *     the conversation-channel listener catches `tool_permission_request`
 *     broadcasts (the old originChannelId observer path is gone) and notifies
 *     the client + ElevenLabs.
 *
 * Strategy: same pattern as the existing voice suite — stub constructor deps,
 * invoke private methods via `(handler as any)`, FakeWs for sockets.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { VoiceHandler } from '../../src/handlers/voice-handler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class FakeWs {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  send = (data: string) => { this.sent.push(data); };
  close = () => { this.closed = true; };
}

function makeDb(opts: {
  channels?: Record<string, { channelId: string; userId: string; workspaceId?: string; metadata?: any }>;
  agents?: Record<string, { agentId: string; workspaceId?: string }>;
  voiceSessionUpdates?: any[];
  apiTokenUser?: string | null;
} = {}) {
  const channels = opts.channels ?? {};
  const agents = opts.agents ?? {};
  const voiceSessionUpdates: any[] = opts.voiceSessionUpdates ?? [];

  const collection = (name: string) => {
    if (name === 'channels') {
      return {
        findOne: async (q: any) => channels[q.channelId] ?? null,
        updateOne: async () => ({ modifiedCount: 1 }),
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      };
    }
    if (name === 'agents') {
      return {
        findOne: async (q: any) => agents[q.agentId] ?? null,
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      };
    }
    if (name === 'voice_sessions') {
      return {
        updateOne: async (filter: any, update: any) => {
          voiceSessionUpdates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
        },
        findOne: async () => null,
      };
    }
    if (name === 'api_tokens') {
      return {
        findOne: async () =>
          opts.apiTokenUser === undefined ? { userId: 'u1' } : (opts.apiTokenUser ? { userId: opts.apiTokenUser } : null),
      };
    }
    // users / channel_messages
    return {
      findOne: async () => null,
      find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      updateOne: async () => ({ modifiedCount: 1 }),
    };
  };

  return { db: { collection } as any, voiceSessionUpdates };
}

function makeChannelManager(channels: Record<string, any>) {
  return {
    getChannel: async (id: string) => channels[id] ?? null,
    createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async () => {},
  } as any;
}

function makeHandler(opts: {
  channels?: Record<string, any>;
  agents?: Record<string, any>;
  voiceSessionUpdates?: any[];
} = {}) {
  const { db, voiceSessionUpdates } = makeDb({
    channels: opts.channels,
    agents: opts.agents,
    voiceSessionUpdates: opts.voiceSessionUpdates,
  });
  const channelManager = makeChannelManager(opts.channels ?? {});
  const savedChannelMessages: any[] = [];

  const cm = {
    ...channelManager,
    saveMessage: async (msg: any) => { savedChannelMessages.push(msg); },
  };

  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic() {},
  };

  const subscriptionService = {
    async createChannelSubscriptionsBatch() { return []; },
    async deleteChannelSubscription() { return true; },
  };

  // authenticateUser('s1') → validateSession → must succeed so handleConnection
  // reaches the channel-resolution step (the code under test).
  const authService = {
    validateSession: async () => ({ success: true, user: { userId: 'u1' } }),
  };

  // assertCanCreateChannel (SEC-2) requires a workspaceService — stub it so the
  // gate passes (member of ws1) and the flow reaches channel resolution.
  const workspaceService = {
    canAccess: async () => true,
  };

  const handler = new VoiceHandler(
    db,
    {} as any,
    cm as any,
    {} as any,
    {} as any,
    subscriptionService as any,
    authService as any,
    workspaceService as any,
  );
  handler.setPubSubService(pubSubService as any);

  return { handler, savedChannelMessages, voiceSessionUpdates };
}

function makeConnection(mode: 'active' | 'silent' = 'active') {
  return {
    clientWs: new FakeWs(),
    elevenLabsWs: new FakeWs(),
    userId: 'u1',
    workspaceId: 'ws1',
    voiceChannelId: 'ch_conv',
    chatChannelId: 'ch_conv',
    agentId: 'agent1',
    sessionId: 's1',
    activeWorkerChannels: new Map<string, string[]>(),
    channelReadsThisTurn: new Set<string>(),
    mode,
    agentName: 'Alice',
    responsePassThrough: false,
    ackPassThrough: false,
  };
}

// ---------------------------------------------------------------------------
// 1) handleConnection — channel resolution (REQ-2)
// ---------------------------------------------------------------------------

describe('Voice Mode v2 F0: handleConnection channel resolution (REQ-2)', () => {
  it('rejects with channel_required when no chatChannelId and no existingChannelId (no orphan voice channel)', async () => {
    // Workspace resolves via the agent fallback (no channel yet) — the agents
    // fixture carries a workspaceId so handleConnection reaches step 3.
    const { handler } = makeHandler({ agents: { agent1: { agentId: 'agent1', workspaceId: 'ws1' } } });
    const clientWs = new FakeWs();

    await (handler as any).handleConnection(clientWs, 's1', 'agent1', undefined, undefined);

    // Typed error frame sent to the client, socket closed
    const errFrame = clientWs.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'error');
    expect(errFrame).toBeDefined();
    expect(errFrame.code).toBe('channel_required');
    expect(clientWs.closed).toBe(true);

    // No connection was registered (no orphan voice session)
    expect((handler as any).connections.size).toBe(0);
  });

  it('rejects with channel_unavailable when the chatChannelId does not exist', async () => {
    const { handler } = makeHandler({
      channels: {}, // no channels at all — workspace falls back to the agent
      agents: { agent1: { agentId: 'agent1', workspaceId: 'ws1' } },
    });
    const clientWs = new FakeWs();

    await (handler as any).handleConnection(clientWs, 's1', 'agent1', undefined, 'ch_missing');

    const errFrame = clientWs.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'error');
    expect(errFrame).toBeDefined();
    expect(errFrame.code).toBe('channel_unavailable');
    expect(clientWs.closed).toBe(true);
    expect((handler as any).connections.size).toBe(0);
  });

  it('rejects with channel_unavailable when the chatChannelId belongs to another user', async () => {
    const channels = {
      ch_other: { channelId: 'ch_other', userId: 'u2', workspaceId: 'ws1', metadata: { name: 'Other' } },
    };
    // assertCanCreateChannel (SEC-2) checks the agent exists before channel
    // resolution — provide it so the flow reaches the ownership check.
    const { handler } = makeHandler({
      channels,
      agents: { agent1: { agentId: 'agent1', workspaceId: 'ws1' } },
    });
    const clientWs = new FakeWs();

    // apiTokenUser 'u1' (makeDb default) ≠ channel owner 'u2' → unauthorized
    await (handler as any).handleConnection(clientWs, 's1', 'agent1', undefined, 'ch_other');

    const errFrame = clientWs.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'error');
    expect(errFrame).toBeDefined();
    expect(errFrame.code).toBe('channel_unavailable');
    expect(clientWs.closed).toBe(true);
    expect((handler as any).connections.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2) saveTranscript — single write, dual-write eliminated (AC-2)
// ---------------------------------------------------------------------------

describe('Voice Mode v2 F0: saveTranscript single write (dual-write eliminated)', () => {
  it('persists exactly ONE channel_messages write to the conversation channel with source:voice', async () => {
    const { handler, savedChannelMessages } = makeHandler();
    const conn = makeConnection();

    await (handler as any).saveTranscript('ch_conv', 'Hola desde voz', true, conn);

    expect(savedChannelMessages.length).toBe(1); // NOT two (old dual-write)
    expect(savedChannelMessages[0].channelId).toBe('ch_conv'); // the conversation channel
    expect(savedChannelMessages[0].source).toBe('voice');
    expect(savedChannelMessages[0].role).toBe('user');
    expect(savedChannelMessages[0].content.text).toBe('Hola desde voz');
  });

  it('system lines (tool calls, errors) also persist ONCE to the conversation channel', async () => {
    const { handler, savedChannelMessages } = makeHandler();
    const conn = makeConnection();

    await (handler as any).saveTranscript('ch_conv', '🛠️ send-message → [ch_conv]', true, conn);
    await (handler as any).saveTranscript('ch_conv', '❌ Error en tool call: boom', false, conn);

    expect(savedChannelMessages.length).toBe(2);
    for (const msg of savedChannelMessages) {
      expect(msg.channelId).toBe('ch_conv');
      expect(msg.source).toBe('voice');
    }
  });
});

// ---------------------------------------------------------------------------
// 3) voice_sessions — persistent session state (REQ-6)
// ---------------------------------------------------------------------------

describe('Voice Mode v2 F0: voice_sessions persistence (REQ-6)', () => {
  it('upsertVoiceSession writes one record per (channelId, agentId) with canonical mode conversation', async () => {
    const voiceSessionUpdates: any[] = [];
    const { handler } = makeHandler({ voiceSessionUpdates });
    const conn = makeConnection('active');

    await (handler as any).upsertVoiceSession(conn);

    expect(voiceSessionUpdates.length).toBe(1);
    const { filter, update } = voiceSessionUpdates[0];
    expect(filter).toEqual({ channelId: 'ch_conv', agentId: 'agent1' });
    // canonical mode mapping: legacy 'active' → 'conversation'
    expect(update.$set.mode).toBe('conversation');
    expect(update.$set.presence).toBe('on');
    expect(update.$set.userId).toBe('u1');
    // $setOnInsert carries the immutable identity fields
    expect(update.$setOnInsert.channelId).toBe('ch_conv');
    expect(update.$setOnInsert.agentId).toBe('agent1');
    expect(update.$setOnInsert.sessionId).toMatch(/^vs_/);
    expect(update.$setOnInsert.startedAt).toBeInstanceOf(Date);
  });

  it('maps legacy silent mode to canonical passive', async () => {
    const voiceSessionUpdates: any[] = [];
    const { handler } = makeHandler({ voiceSessionUpdates });
    const conn = makeConnection('silent');

    await (handler as any).upsertVoiceSession(conn);

    expect(voiceSessionUpdates[0].update.$set.mode).toBe('passive');
  });

  it('touchVoiceSession updates lastActivityAt + current mode', async () => {
    const voiceSessionUpdates: any[] = [];
    const { handler } = makeHandler({ voiceSessionUpdates });
    const conn = makeConnection('silent');

    await (handler as any).touchVoiceSession(conn);

    expect(voiceSessionUpdates.length).toBe(1);
    const { filter, update } = voiceSessionUpdates[0];
    expect(filter).toEqual({ channelId: 'ch_conv', agentId: 'agent1' });
    expect(update.$set.mode).toBe('passive');
    expect(update.$set.lastActivityAt).toBeInstanceOf(Date);
  });

  it('closeVoiceSession marks presence off and keeps the record (mode survives)', async () => {
    const voiceSessionUpdates: any[] = [];
    const { handler } = makeHandler({ voiceSessionUpdates });
    const conn = makeConnection('active');

    await (handler as any).closeVoiceSession(conn);

    expect(voiceSessionUpdates.length).toBe(1);
    const { filter, update } = voiceSessionUpdates[0];
    expect(filter).toEqual({ channelId: 'ch_conv', agentId: 'agent1' });
    expect(update.$set.presence).toBe('off');
    expect(update.$set.mode).toBe('conversation');
    expect(update.$set.endedAt).toBeInstanceOf(Date);
  });

  it('toCanonicalMode maps the legacy axis to the canonical axis', () => {
    const { handler } = makeHandler();
    expect((handler as any).toCanonicalMode('active')).toBe('conversation');
    expect((handler as any).toCanonicalMode('silent')).toBe('passive');
  });
});

// ---------------------------------------------------------------------------
// 4) Permission verbal notification preserved (single-channel model)
// ---------------------------------------------------------------------------

describe('Voice Mode v2 F0: permission notification on the conversation channel', () => {
  it('the channel listener catches tool_permission_request and notifies client + ElevenLabs', async () => {
    const channels = {
      ch_conv: { channelId: 'ch_conv', userId: 'u1', metadata: { name: 'Main chat' } },
    };
    const { handler } = makeHandler({ channels });
    const conn = makeConnection();
    (handler as any).connections.set('conn1', conn);
    (handler as any).setupVoiceChannelListener('conn1');

    // The permission manager broadcasts tool_permission_request on the
    // conversation channel (executor = conversation channel, single model).
    const listener = (conn as any)._voiceChannelListener;
    expect(listener).toBeDefined();

    await listener(JSON.stringify({
      type: 'tool_permission_request',
      channelId: 'ch_conv',
      toolName: 'send_email',
    }));

    // Client got the channel_event notification (VoiceWindow permission card)
    const clientFrames = (conn.clientWs as FakeWs).sent.map((s) => JSON.parse(s));
    const permEvent = clientFrames.find((m) => m.type === 'channel_event' && m.eventType === 'channel_permission');
    expect(permEvent).toBeDefined();
    expect(permEvent.toolName).toBe('send_email');
    expect(permEvent.observedChannelId).toBe('ch_conv');
    expect(permEvent.observedChannelName).toBe('Main chat');

    // ElevenLabs got the verbal notification
    const elFrames = (conn.elevenLabsWs as FakeWs).sent.map((s) => JSON.parse(s));
    const verbal = elFrames.find((m) => m.type === 'user_message' && String(m.text).includes('permission_required'));
    expect(verbal).toBeDefined();
    expect(String(verbal.text)).toContain('tool=send_email');
  });
});
