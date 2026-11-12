/**
 * Voice overheard → session_messages (LLM context) — the voice→text continuity fix.
 *
 * Bug: overheard utterances (REQ-9) persisted ONLY to channel_messages (the
 * visible thread) + an in-memory buffer. The LLM context of every turn is
 * built from session_messages (getMessagesForLLM), so overheard lines only
 * reached the agent when they happened to ride an activated voice turn
 * (buildOverheardContext). A text message after the voice session ("Thanks")
 * ran with NO memory of what had been said around it.
 *
 * Fix: every overheard utterance is mirrored into session_messages AS IT IS
 * HEARD (persistOverheardToSessionStore) as a synthetic user message — the
 * same store the text engine reads — so all subsequent turns (voice or text)
 * share one context.
 *
 * Harness pattern: same as voice-loop-f2b.test.ts (mocked STT/TTS, stub deps,
 * FakeWs). The session store is a fake capturing writeMessage/writePart —
 * the shape written here is exactly what MongoSessionStore.getMessagesForLLM
 * projects into the LLM prompt (info.role + parts[].text).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';
import type { IStreamingTranscriptionProvider, StreamingTranscriptionCallbacks } from '../../src/services/transcription/IStreamingTranscriptionProvider';
import type { ITtsProvider, TtsStreamCallbacks } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Fake WebSocket (same as the F2b suite)
// ---------------------------------------------------------------------------

class FakeWs {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  handlers: Record<string, ((data?: any) => void)[]> = {};
  send = (data: string) => { this.sent.push(data); };
  close = () => {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.handlers['close'] ?? []) h();
  };
  on = (event: string, handler: (data?: any) => void) => {
    (this.handlers[event] ??= []).push(handler);
  };
  receive = (payload: object) => {
    for (const h of this.handlers['message'] ?? []) h(Buffer.from(JSON.stringify(payload)));
  };
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

// ---------------------------------------------------------------------------
// Mock STT / TTS providers
// ---------------------------------------------------------------------------

class MockStt implements IStreamingTranscriptionProvider {
  callbacks: StreamingTranscriptionCallbacks | null = null;
  async connect(callbacks: StreamingTranscriptionCallbacks) { this.callbacks = callbacks; }
  sendAudio(base64Audio: string) { void base64Audio; }
  close() {}
  isOpen() { return true; }
  interim(text: string) { this.callbacks?.onInterim(text); }
  final(text: string) { this.callbacks?.onFinal(text); }
}

class MockTts implements ITtsProvider {
  callbacks: TtsStreamCallbacks | null = null;
  fed: string[] = [];
  cancelled = 0;
  endOfTextCount = 0;
  active = false;
  speak(callbacks: TtsStreamCallbacks) { this.callbacks = callbacks; this.active = true; }
  feed(text: string) { this.fed.push(text); }
  endOfText() { this.endOfTextCount++; }
  cancel() { this.cancelled++; this.active = false; }
  isSpeaking() { return this.active; }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeLoop(opts: { wireSessionStore?: boolean } = {}) {
  const channels: Record<string, any> = {
    ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  };
  const agents: Record<string, any> = { agent1: { agentId: 'agent1', name: 'Alice', workspaceId: 'ws1' } };
  const voiceSessions: Record<string, any> = {};
  const savedChannelMessages: any[] = [];
  const agentTurns: Array<{ channelId: string; agentId: string; text: string }> = [];

  // The fake session store: captures what the loop writes into the LLM
  // context store (session_messages). Shape contract with
  // MongoSessionStore.getMessagesForLLM: messages carry info.role; parts
  // carry { type:'text', text } and are joined by the prompt builder.
  const sessionStore = {
    writtenMessages: [] as any[],
    writtenParts: [] as any[],
    writeMessage: async (m: any) => { sessionStore.writtenMessages.push(m); },
    writePart: async (p: any) => { sessionStore.writtenParts.push(p); },
  };

  const collection = (name: string) => {
    if (name === 'channels') {
      return {
        findOne: async (q: any) => channels[q.channelId] ?? null,
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      };
    }
    if (name === 'agents') {
      return { findOne: async (q: any) => agents[q.agentId] ?? null };
    }
    if (name === 'voice_sessions') {
      return {
        updateOne: async (filter: any, update: any) => {
          if (update.$set?.mode) {
            voiceSessions[`${filter.channelId}:${filter.agentId}`] = {
              ...(voiceSessions[`${filter.channelId}:${filter.agentId}`] ?? {}),
              mode: update.$set.mode,
              presence: update.$set.presence ?? 'on',
            };
          }
          return { matchedCount: 1, modifiedCount: 1 };
        },
        findOne: async (q: any) => voiceSessions[`${q.channelId}:${q.agentId}`] ?? null,
      };
    }
    if (name === 'channel_messages') {
      return {
        insertOne: async (doc: any) => { savedChannelMessages.push(doc); },
        find: (_q: any, _opts: any) => ({
          sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
          toArray: async () => [],
        }),
      };
    }
    return {
      findOne: async () => null,
      find: (_q: any, _opts?: any) => ({
        sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
        toArray: async () => [],
      }),
    };
  };

  const channelManager = {
    getChannel: async (id: string) => channels[id] ?? null,
    createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async (msg: any) => { savedChannelMessages.push(msg); },
  };

  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic() {},
  };

  const authService = { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) };
  const workspaceService = { canAccess: async () => true };
  const messageHandler = {
    processAgentResponse: async (channelId: string, agentId: string, text: string) => {
      agentTurns.push({ channelId, agentId, text });
    },
  };

  const stt = new MockStt();
  const tts = new MockTts();

  const loop = new VoiceLoop(
    { collection } as any,
    channelManager as any,
    {} as any,
    messageHandler as any,
    workspaceService as any,
    null,
    authService as any,
    { sttFactory: () => stt, ttsFactory: () => tts },
  );
  loop.setPubSubService(pubSubService as any);
  if (opts.wireSessionStore !== false) loop.setSessionStore(sessionStore as any);

  return { loop, stt, agentTurns, savedChannelMessages, sessionStore };
}

async function connect(harness: ReturnType<typeof makeLoop>) {
  const ws = new FakeWs();
  await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
  return ws;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

let harness: ReturnType<typeof makeLoop>;

beforeEach(() => {
  harness = makeLoop();
});

// ---------------------------------------------------------------------------
// 1. The fix: overheard lines land in session_messages AS THEY ARE HEARD
// ---------------------------------------------------------------------------

describe('VoiceLoop overheard → session_messages (voice→text continuity)', () => {
  it('persists each overheard utterance as a synthetic user message, immediately', async () => {
    const ws = await connect(harness);

    // Passive mode: every non-vocative utterance is overheard.
    harness.stt.final('ponte en modo silencio');
    await flush();

    harness.stt.final('estoy pensando en separar comunicación de acciones');
    await flush();
    harness.stt.final('y el framework de toma de decisiones');
    await flush();

    // Two overheard utterances → two session-store user messages.
    expect(harness.sessionStore.writtenMessages.length).toBe(2);
    expect(harness.sessionStore.writtenParts.length).toBe(2);

    const first = harness.sessionStore.writtenMessages[0];
    expect(first.role).toBe('user');
    expect(first.sessionID).toBe('ch_conv');

    const part = harness.sessionStore.writtenParts[0];
    expect(part.type).toBe('text');
    expect(part.text).toBe('estoy pensando en separar comunicación de acciones');
    expect(part.messageID).toBe(first.id);
    expect(part.synthetic).toBe(true);
    expect(part.metadata).toEqual({ source: 'voice', overheard: true });

    // The visible thread still gets the overheard row (unchanged REQ-9 behavior).
    const ohRow = harness.savedChannelMessages.find((m) => m.overheard);
    expect(ohRow).toBeTruthy();
    expect(ohRow.source).toBe('voice');

    void ws;
  });

  it('writes the exact shape getMessagesForLLM projects into the LLM prompt', async () => {
    const ws = await connect(harness);

    harness.stt.final('ponte en modo silencio');
    await flush();
    harness.stt.final('nota al margen sobre los boards');
    await flush();

    // MongoSessionStore.writeMessage wraps the message as
    // { sessionId, info: message, parts } and getMessagesForLLM filters on
    // info.role and joins parts[].text — so the row the loop hands over must
    // be a message-shaped object (role/sessionID at top level, as the legacy
    // AF-5 write and MessageHandler.persistToSessionStore do).
    const msg = harness.sessionStore.writtenMessages[0];
    const part = harness.sessionStore.writtenParts[0];
    expect(msg.role).toBe('user');
    expect(msg.sessionID).toBe('ch_conv');
    expect(msg.id).toBe(part.messageID);
    expect(part.text).toBe('nota al margen sobre los boards');
    expect(part.synthetic).toBe(true);

    void ws;
  });

  it('does NOT double-write the buffered lines when a turn activates', async () => {
    const ws = await connect(harness);

    harness.stt.final('ponte en modo silencio');
    await flush();
    harness.stt.final('primer apunte overheard');
    await flush();
    harness.stt.final('segundo apunte overheard');
    await flush();
    expect(harness.sessionStore.writtenMessages.length).toBe(2);

    // The vocative opens an activated turn — the buffer rides it as a note,
    // but the lines are NOT re-written into the session store.
    harness.stt.final('Alice, ¿qué hemos hablado?');
    await flush();

    expect(harness.agentTurns.length).toBe(1);
    expect(harness.agentTurns[0].text).toContain('primer apunte overheard');
    expect(harness.sessionStore.writtenMessages.length).toBe(2);

    void ws;
  });

  it('keeps working (channel_messages only) when no session store is wired', async () => {
    const bare = makeLoop({ wireSessionStore: false });
    const ws = await connect(bare);

    bare.stt.final('ponte en modo silencio');
    await flush();
    bare.stt.final('overheard sin store');
    await flush();

    // No crash, no writes, visible-tenue row still lands.
    expect(bare.sessionStore.writtenMessages.length).toBe(0);
    const ohRow = bare.savedChannelMessages.find((m) => m.overheard);
    expect(ohRow).toBeTruthy();
    expect(ohRow.content.text).toBe('overheard sin store');

    void ws;
  });
});
