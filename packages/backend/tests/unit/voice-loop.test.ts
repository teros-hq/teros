/**
 * Voice Mode v2 — F1a integration tests (spec v1.1.0, REQ-1/REQ-3/REQ-7 subset).
 *
 * Covers the native voice loop end-to-end with MOCKED STT/TTS providers
 * (injected via the provider factories — no real network, no real keys):
 *
 *  1. Connection lifecycle (F0 contract preserved):
 *     - rejects `channel_required` / `channel_unavailable` (no orphan channels)
 *     - voice_sessions upsert on connect (mode + engine 'native' + presence 'on')
 *     - `voice_channel` frame with historic transcripts on resume
 *
 *  2. The pipeline (REQ-1 — the brain is the Teros agent):
 *     - STT interim → `transcript {partial}` frames to the client
 *     - STT final → ONE channel_messages write (source:'voice') + broadcast
 *       → messageHandler.processAgentResponse called on the conversation channel
 *     - assistant `text_chunk` broadcasts → TTS speak/feed + `agent_response_delta`
 *       + `tts_chunk` frames in order, bracketed by speaking_started/ended
 *     - `queue_state done` → tts.endOfText() (final partial sentence drained)
 *
 *  3. Mode gate (REQ-7 F1a subset):
 *     - conversation (default): every final transcript → agent turn
 *     - passive: non-vocative → overheard persistence, NO agent turn
 *     - passive: vocative "Alice, …" → agent turn
 *     - third-person "le dije a Alice que…" → NOT vocative
 *     - set_mode frame → mode_changed frame + voice_sessions touch
 *
 *  4. Barge-in v1 (REQ-4 partial): interrupt frame → tts.cancel() + interrupt frame back.
 *
 *  5. Latency instrumentation (AC): STT-final → first TTS audio measured (mock timing).
 *
 *  6. Barge-in F1b (REQ-4 complete): VAD server-side (onSpeechStart) and client
 *     frame both cut the TTS; the interrupted turn's late text chunks never
 *     reopen the TTS (no audio overlap); playback position is registered,
 *     persisted as context, and attached to the interrupting utterance's turn.
 *
 *  7. Latency budget (F1b, NFR-1): per-segment p50/p95 + end-to-end percentiles
 *     with within-budget verdicts against the NFR lines (mock clock).
 *
 * Strategy: same harness pattern as the F0 suite — FakeWs, stub constructor
 * deps, invoke private methods via `(loop as any)`, mock STT/TTS factories.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { VoiceLoop, isVocativeAddress } from '../../src/handlers/voice-loop';
import type { IStreamingTranscriptionProvider, StreamingTranscriptionCallbacks } from '../../src/services/transcription/IStreamingTranscriptionProvider';
import type { ITtsProvider, TtsStreamCallbacks } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWs {
  sent: string[] = [];
  closed = false;
  readyState = 1;
  handlers: Record<string, ((data?: any) => void)[]> = {};
  send = (data: string) => { this.sent.push(data); };
  close = () => { this.closed = true; };
  on = (event: string, handler: (data?: any) => void) => {
    (this.handlers[event] ??= []).push(handler);
  };
  /** Test helper: simulate an inbound client frame. */
  receive = (payload: object) => {
    for (const h of this.handlers['message'] ?? []) h(Buffer.from(JSON.stringify(payload)));
  };
  frames() { return this.sent.map((s) => JSON.parse(s)); }
  lastFrame() { const f = this.frames(); return f[f.length - 1]; }
}

// ---------------------------------------------------------------------------
// Mock STT / TTS providers
// ---------------------------------------------------------------------------

class MockStt implements IStreamingTranscriptionProvider {
  callbacks: StreamingTranscriptionCallbacks | null = null;
  audio: string[] = [];
  closed = false;
  async connect(callbacks: StreamingTranscriptionCallbacks) { this.callbacks = callbacks; }
  sendAudio(base64Audio: string) { this.audio.push(base64Audio); }
  close() { this.closed = true; }
  isOpen() { return !this.closed; }
  /** Test helpers: simulate Deepgram events. */
  interim(text: string) { this.callbacks?.onInterim(text); }
  final(text: string) { this.callbacks?.onFinal(text); }
  error(message: string) { this.callbacks?.onError(new Error(message)); }
  /** Test helper: simulate the VAD speech-start event (first interim of a new utterance). */
  speechStart() { this.callbacks?.onSpeechStart?.(); }
}

class MockTts implements ITtsProvider {
  callbacks: TtsStreamCallbacks | null = null;
  fed: string[] = [];
  cancelled = 0;
  endOfTextCount = 0;
  flushCount = 0;
  active = false;
  speak(callbacks: TtsStreamCallbacks) { this.callbacks = callbacks; this.active = true; }
  feed(text: string) { this.fed.push(text); }
  endOfText() { this.endOfTextCount++; }
  flush() { this.flushCount++; }
  cancel() { this.cancelled++; this.active = false; }
  isSpeaking() { return this.active; }
  /** Test helper: simulate audio flowing. */
  deliverChunk(base64 = 'QUJD') { this.callbacks?.onChunk(base64); }
  /**
   * Test helper: simulate the turn completing (the real providers go
   * inactive BEFORE firing onEnd — ElevenLabsStream sets active=false then
   * cb?.onEnd(); the mock must match or isSpeaking() lies after a turn).
   */
  end() { this.active = false; this.callbacks?.onEnd(); }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDb(opts: {
  channels?: Record<string, any>;
  agents?: Record<string, any>;
  voiceSessions?: Record<string, any>;
} = {}) {
  const channels = opts.channels ?? {};
  const agents = opts.agents ?? { agent1: { agentId: 'agent1', name: 'Alice', workspaceId: 'ws1' } };
  const voiceSessions = opts.voiceSessions ?? {};
  const voiceSessionUpdates: any[] = [];
  const telemetryUpserts: any[] = [];
  const savedChannelMessages: any[] = [];
  const broadcasts: any[] = [];

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
          voiceSessionUpdates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
        findOne: async (q: any) => voiceSessions[`${q.channelId}:${q.agentId}`] ?? null,
      };
    }
    if (name === 'voice_telemetry_sessions') {
      // F4: the session health record sink (upsert keyed by recordId).
      return {
        updateOne: async (filter: any, update: any) => {
          telemetryUpserts.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
        find: (_q: any, _opts: any) => ({ toArray: async () => [] }),
      };
    }
    if (name === 'channel_messages') {
      return {
        insertOne: async (doc: any) => { savedChannelMessages.push(doc); },
        // Real Mongo signature: find(query, { sort, limit }) → cursor.toArray()
        find: (_q: any, _opts: any) => ({
          sort: () => ({
            limit: () => ({ toArray: async () => [] }),
          }),
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

  return {
    db: { collection } as any,
    voiceSessionUpdates,
    telemetryUpserts,
    savedChannelMessages,
    broadcasts,
  };
}

function makeLoop(opts: {
  channels?: Record<string, any>;
  agents?: Record<string, any>;
  voiceSessions?: Record<string, any>;
  processAgentResponseImpl?: (channelId: string, agentId: string, text: string, messageId?: string, onComplete?: () => void) => Promise<void>;
} = {}) {
  const { db, voiceSessionUpdates, telemetryUpserts } = makeDb(opts);

  const savedChannelMessages: any[] = [];
  const broadcasts: any[] = [];
  const agentTurns: Array<{ channelId: string; agentId: string; text: string; onComplete?: () => void }> = [];

  const channelManager = {
    getChannel: async (id: string) => (opts.channels ?? {})[id] ?? null,
    createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async (msg: any) => { savedChannelMessages.push(msg); },
  };

  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic(topic: string, event: any) { broadcasts.push({ topic, event }); },
  };

  const authService = {
    validateSession: async () => ({ success: true, user: { userId: 'u1' } }),
  };

  const workspaceService = { canAccess: async () => true };

  const messageHandler = {
    processAgentResponse: opts.processAgentResponseImpl ??
      (async (channelId: string, agentId: string, text: string, _messageId?: string, onComplete?: () => void) => {
        agentTurns.push({ channelId, agentId, text, onComplete });
      }),
  };

  const stt = new MockStt();
  const tts = new MockTts();

  const loop = new VoiceLoop(
    db,
    channelManager as any,
    {} as any,
    messageHandler as any,
    workspaceService as any,
    null,
    authService as any,
    {
      sttFactory: () => stt,
      ttsFactory: () => tts,
    },
  );
  loop.setPubSubService(pubSubService as any);

  return { loop, stt, tts, agentTurns, savedChannelMessages, voiceSessionUpdates, telemetryUpserts, broadcasts, db };
}

const CHANNELS = {
  ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  ch_other: { channelId: 'ch_other', userId: 'u2', workspaceId: 'ws1' },
};

/**
 * Flush pending microtasks/timers. `onFinal` fires `handleFinalTranscript`
 * asynchronously (fire-and-forget, like the real Deepgram WS events) — tests
 * must await this before asserting on its effects.
 */
async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// Vocative gate (pure function)
// ---------------------------------------------------------------------------

describe('isVocativeAddress (REQ-7 layer 1)', () => {
  it('matches a vocative at the start', () => {
    expect(isVocativeAddress('Alice, ¿tú cómo lo ves?', 'Alice')).toBe(true);
    expect(isVocativeAddress('alice resume el fichero B.md', 'Alice')).toBe(true);
  });

  it('rejects third-person mentions', () => {
    expect(isVocativeAddress('le dije a Alice que viniera', 'Alice')).toBe(false);
    expect(isVocativeAddress('Alice está haciendo algo', 'Alice')).toBe(false);
    expect(isVocativeAddress('Alice dice que no', 'Alice')).toBe(false);
  });

  it('rejects utterances without the name', () => {
    expect(isVocativeAddress('¿y el pico de agosto?', 'Alice')).toBe(false);
  });

  it('normalizes punctuation and case', () => {
    expect(isVocativeAddress('¡Alice, hola!', 'Alice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe('VoiceLoop.handleConnection (F0 contract preserved)', () => {
  it('rejects with channel_required when no channel is provided', async () => {
    const { loop } = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1');
    expect(ws.frames()[0]).toEqual({
      type: 'error', code: 'channel_required', message: expect.stringContaining('chatChannelId'),
    });
    expect(ws.closed).toBe(true);
  });

  it('rejects with channel_unavailable when the channel is not the user\'s', async () => {
    const { loop } = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_other');
    expect(ws.frames()[0].code).toBe('channel_unavailable');
    expect(ws.closed).toBe(true);
  });

  it('upserts voice_sessions (mode, engine native, presence on) and sends voice_channel', async () => {
    const { loop, voiceSessionUpdates } = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    const upsert = voiceSessionUpdates.find((u) => u.update.$setOnInsert);
    expect(upsert).toBeDefined();
    expect(upsert.filter).toEqual({ channelId: 'ch_conv', agentId: 'agent1' });
    expect(upsert.update.$set.mode).toBe('conversation');
    expect(upsert.update.$set.engine).toBe('native');
    expect(upsert.update.$set.presence).toBe('on');

    const frame = ws.frames().find((f) => f.type === 'voice_channel');
    expect(frame).toBeDefined();
    expect(frame.channelId).toBe('ch_conv');
    expect(frame.isResuming).toBe(true);
  });

  it('restores the persisted mode on reconnect (REQ-6) — passive stays passive', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // passive restored: a non-vocative final is overheard, NOT an agent turn.
    harness.stt.final('hablando con otra persona');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);

    // And the upsert/touch persists the restored mode.
    const touch = harness.voiceSessionUpdates.find((u) => u.update.$set && !u.update.$setOnInsert);
    expect(touch.update.$set.mode).toBe('passive');
  });
});

// ---------------------------------------------------------------------------
// The pipeline — STT final → Teros turn → TTS
// ---------------------------------------------------------------------------

describe('VoiceLoop pipeline (REQ-1, REQ-3)', () => {
  it('STT interim → transcript {partial} frames to the client', async () => {
    const { loop, stt } = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    stt.interim('hola que');
    stt.interim('hola qué tal');

    const partials = ws.frames().filter((f) => f.type === 'transcript' && f.partial);
    expect(partials.map((f) => f.text)).toEqual(['hola que', 'hola qué tal']);
    expect(partials.every((f) => f.isUser)).toBe(true);
  });

  it('STT final → ONE channel_messages write (source:voice) + broadcast + agent turn on the conversation channel', async () => {
    const { loop, stt, agentTurns, savedChannelMessages, broadcasts } = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    stt.final('resume el fichero B.md');
    await flush();

    // Exactly one persisted transcript line.
    expect(savedChannelMessages.length).toBe(1);
    expect(savedChannelMessages[0].source).toBe('voice');
    expect(savedChannelMessages[0].channelId).toBe('ch_conv');
    expect(savedChannelMessages[0].content.text).toBe('resume el fichero B.md');

    // Broadcast to the channel (chat UI sees the spoken turn).
    expect(broadcasts.some((b) => b.topic === 'channel:ch_conv')).toBe(true);

    // The brain: processAgentResponse on the conversation channel.
    expect(agentTurns.length).toBe(1);
    expect(agentTurns[0].channelId).toBe('ch_conv');
    expect(agentTurns[0].agentId).toBe('agent1');
    // F2a layer 3: the FIRST turn after connect carries the voice-session
    // context note (the LLM knows it is spoken + decides response-worthiness).
    expect(agentTurns[0].text).toContain('resume el fichero B.md');
    expect(agentTurns[0].text).toContain('modo conversación');
    // The note is consumed once — a later turn is the bare transcript.
    stt.final('otra cosa');
    await flush();
    expect(agentTurns[1].text).toBe('otra cosa');

    // Final transcript frame to the client (not partial, not overheard).
    const finalFrame = ws.frames().find((f) => f.type === 'transcript' && !f.partial);
    expect(finalFrame.text).toBe('resume el fichero B.md');
    expect(finalFrame.overheard).toBeUndefined();
  });

  it('text_chunk broadcasts → TTS speak+feed, tts_chunk frames, speaking marks, ordered audio', async () => {
    // processAgentResponse simulates the real pipeline: broadcasts text chunks
    // (as the message-handler does) and calls onComplete at the end.
    const { loop, stt, tts } = makeLoop({
      channels: CHANNELS,
      processAgentResponseImpl: async (channelId, agentId, text, _messageId, onComplete) => {
        const { broadcasts } = (loop as any); // eslint-disable-line
        // Simulate via the loop's own pubsub: the test broadcasts directly.
        onComplete?.();
      },
    });
    // We need the pubsub broadcasts — re-create with access.
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Simulate the agent turn's text_chunk broadcasts through the listener.
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'Claro. ' }));
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'Resumen del fichero B.md.' }));

    expect(harness.tts.fed).toEqual(['Claro. ', 'Resumen del fichero B.md.']);
    const deltas = ws.frames().filter((f) => f.type === 'agent_response_delta');
    expect(deltas.map((d) => d.text)).toEqual(['Claro. ', 'Resumen del fichero B.md.']);

    // Simulate TTS audio flowing + turn completion.
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');
    harness.tts.deliverChunk('BBBB');
    harness.tts.callbacks!.onEnd();

    const types = ws.frames().map((f) => f.type);
    expect(types).toContain('speaking_started');
    expect(types).toContain('tts_chunk');
    expect(types).toContain('speaking_ended');
    const chunks = ws.frames().filter((f) => f.type === 'tts_chunk');
    expect(chunks.map((c) => c.audio_base_64)).toEqual(['AAAA', 'BBBB']);
    // speaking_started comes before the first tts_chunk.
    expect(types.indexOf('speaking_started')).toBeLessThan(types.indexOf('tts_chunk'));
  });

  it('queue_state done → tts.endOfText (final partial sentence drained)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'una frase sin terminar' }));
    expect(harness.tts.endOfTextCount).toBe(0);

    listener(JSON.stringify({ type: 'queue_state', channelId: 'ch_conv', state: 'done' }));
    expect(harness.tts.endOfTextCount).toBe(1);
  });

  it('tool_call_start → tts.flush (the preface sounds while the tool runs; the turn stays open)', async () => {
    // Pablo, PoC 2026-10-31: the audio "paused" during tool calls — the text
    // fed before the call sat in the provider's buffer (chunk_length_schedule)
    // until the post-tool text pushed it over the threshold.
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    const listener = (harness.loop as any).connections.values().next().value.listener;
    // No stream yet → nothing to flush.
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'tool_call_start', toolName: 'search' }));
    expect(harness.tts.flushCount).toBe(0);

    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'Vale, voy a mirarlo' }));
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'tool_call_start', toolName: 'search' }));
    expect(harness.tts.flushCount).toBe(1);
    expect(harness.tts.endOfTextCount).toBe(0);
    expect(harness.tts.isSpeaking()).toBe(true);

    // The text after the tool result keeps feeding the SAME stream.
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'tool_call_complete', toolName: 'search', toolOutput: '{}' }));
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: ' Hay tres resultados.' }));
    expect(harness.tts.fed).toEqual(['Vale, voy a mirarlo', ' Hay tres resultados.']);
    listener(JSON.stringify({ type: 'queue_state', channelId: 'ch_conv', state: 'done' }));
    expect(harness.tts.endOfTextCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mode gate (REQ-7 F1a subset)
// ---------------------------------------------------------------------------

describe('VoiceLoop mode gate', () => {
  it('conversation (default): every final transcript triggers the agent turn', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('¿y el pico de agosto?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
  });

  it('passive: non-vocative final → overheard persistence, NO agent turn', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('hablando con otra persona sobre el informe');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages.length).toBe(1);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);
    expect(harness.savedChannelMessages[0].source).toBe('voice');

    const frame = ws.frames().find((f) => f.type === 'transcript' && !f.partial);
    expect(frame.overheard).toBe(true);
  });

  it('available (Disponible): non-vocative final → NOTHING kept (no row, no frame, no buffer), no agent turn', async () => {
    // Pablo, PoC 2026-10-31 (decisions 1-2): the resting mode of the presence
    // answers when named and stores nothing it overhears.
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'available' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('hablando con otra persona sobre el informe');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages.length).toBe(0);
    expect(ws.frames().find((f) => f.type === 'transcript' && f.overheard)).toBeUndefined();
    const conn = (harness.loop as any).connections.values().next().value;
    expect(conn.overheardBuffer.length).toBe(0);

    // The name still opens the door.
    harness.stt.final('Alice, ¿tú cómo lo ves?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
  });

  it('the opening door can ask for the starting mode: handleConnection(…, "available") beats the persisted mode', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'conversation' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv', 'available');
    const conn = (harness.loop as any).connections.values().next().value;
    expect(conn.mode).toBe('available');
    harness.stt.final('hola qué tal todo'); // unaddressed → nothing
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages.length).toBe(0);
  });

  it('dialogue window (round 5): opens only after a turn by NAME and from real playback end; one follow-up; a closure shuts it', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'available' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const conn = (harness.loop as any).connections.values().next().value;
    const speakAndDrain = async () => {
      conn.listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm', chunkType: 'text_chunk', text: 'Tienes dos reuniones.' }));
      await flush();
      harness.tts.callbacks!.onStart();
      harness.tts.deliverChunk();
      // Send-end alone does NOT open the window any more.
      harness.tts.end();
      expect(conn.gateDialogue.dialogueWindowUntil).toBeNull();
      ws.receive({ type: 'playback_ended' });
      await flush();
    };

    // 1. By name → turn; after the real end of playback the window is open.
    harness.stt.final('Alice, ¿qué tengo hoy?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
    await speakAndDrain();
    expect(conn.gateDialogue.dialogueWindowUntil).not.toBeNull();

    // 2. Follow-up without the name → turn (through the window)…
    harness.stt.final('¿y mañana?');
    await flush();
    expect(harness.agentTurns.length).toBe(2);
    // …but a follow-up does NOT re-open the window after its own playback.
    await speakAndDrain();
    expect(conn.gateDialogue.dialogueWindowUntil).toBeNull();
    harness.stt.final('¿y el viernes?');
    await flush();
    expect(harness.agentTurns.length).toBe(2); // name needed again

    // 3. Closure while the window is open: no turn, window shut, nothing kept (available).
    harness.stt.final('Alice, ¿y el viernes?');
    await flush();
    expect(harness.agentTurns.length).toBe(3);
    await speakAndDrain();
    expect(conn.gateDialogue.dialogueWindowUntil).not.toBeNull();
    harness.stt.final('vale, gracias');
    await flush();
    expect(harness.agentTurns.length).toBe(3);
    expect(conn.gateDialogue.dialogueWindowUntil).toBeNull();
    expect(harness.savedChannelMessages.filter((m: any) => m.overheard).length).toBe(0);
  });

  it('set_mode available through the UI door → mode_changed available; the next overheard line is dropped', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    ws.receive({ type: 'set_mode', mode: 'available' });
    await flush();
    const changed = ws.frames().filter((f) => f.type === 'mode_changed');
    expect(changed[changed.length - 1].mode).toBe('available');

    harness.stt.final('esto es una charla de pasillo');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages.length).toBe(0);
  });

  it('passive: vocative "Alice, …" → agent turn (one-shot breakthrough)', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('Alice, ¿tú cómo lo ves?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
    expect(harness.savedChannelMessages[0].overheard).toBeUndefined();
  });

  it('passive: third-person mention does NOT trigger a turn', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('le dije a Alice que lo haría');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);
  });

  it('set_mode frame → mode_changed frame + voice_sessions touch', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    ws.receive({ type: 'set_mode', mode: 'passive' });

    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame).toEqual({ type: 'mode_changed', mode: 'passive', source: 'ui' });

    // The next non-vocative final is now overheard (mode took effect in-session).
    harness.stt.final('comentario sin dirigirme a ella');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Barge-in v1 (REQ-4 partial)
// ---------------------------------------------------------------------------

describe('VoiceLoop barge-in v1', () => {
  it('interrupt frame → tts.cancel + interrupt frame back (position clamped to delivered audio)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Open a TTS stream (simulating an agent turn speaking) + deliver audio.
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'hablando...' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA'); // 190ms of audio delivered

    // The client reports a position beyond what was delivered — clamped to reality.
    ws.receive({ type: 'interrupt', playbackPositionMs: 1234 });

    expect(harness.tts.cancelled).toBe(1);
    const frame = ws.frames().find((f) => f.type === 'interrupt');
    expect(frame.playbackPositionMs).toBe(190);
  });
});

// ---------------------------------------------------------------------------
// Audio routing + errors
// ---------------------------------------------------------------------------

describe('VoiceLoop client frames', () => {
  it('routes user_audio_chunk (legacy shape) to the STT provider', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    ws.receive({ user_audio_chunk: 'QUJDRA==' });
    expect(harness.stt.audio).toEqual(['QUJDRA==']);
  });

  it('routes user_audio_chunk (v2 contract shape) to the STT provider', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    ws.receive({ type: 'user_audio_chunk', audio_base_64: 'WFhY' });
    expect(harness.stt.audio).toEqual(['WFhY']);
  });

  it('STT error → typed stt_error frame to the client', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.error('boom');
    const frame = ws.frames().find((f) => f.type === 'error');
    expect(frame.code).toBe('stt_error');
    expect(frame.message).toBe('boom');
  });

  it('TTS error → typed tts_error frame to the client', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Open the TTS stream first, then fail it.
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'hola' }));
    harness.tts.callbacks!.onError(new Error('tts boom'));

    const frame = ws.frames().find((f) => f.type === 'error');
    expect(frame.code).toBe('tts_error');
  });

  it('ping → pong', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    ws.receive({ type: 'ping', event_id: 'e1' });
    expect(ws.lastFrame()).toEqual({ type: 'pong', event_id: 'e1' });
  });
});

// ---------------------------------------------------------------------------
// Latency instrumentation (AC)
// ---------------------------------------------------------------------------

describe('VoiceLoop latency (STT-final → first TTS audio)', () => {
  it('measures and exposes the latency per turn', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Final transcript → sttFinalAt set.
    harness.stt.final('pregunta hablada');
    await flush();
    const connectionId = (harness.loop as any).connections.keys().next().value;

    // Simulate the agent turn: text chunks → TTS → first audio.
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', chunkType: 'text_chunk', text: 'respuesta.' }));
    harness.tts.callbacks!.onStart();

    const latency = harness.loop.getLastLatencyMs(connectionId);
    expect(latency).not.toBeNull();
    expect(latency!).toBeGreaterThanOrEqual(0);
    expect(latency!).toBeLessThan(5000); // mock timing sanity
  });
});

// ---------------------------------------------------------------------------
// Barge-in F1b (REQ-4 complete) — VAD server-side + client frame
// ---------------------------------------------------------------------------

describe('VoiceLoop barge-in F1b (REQ-4)', () => {
  /** Open a speaking turn: user final → agent text chunks → TTS audio flowing. */
  async function openSpeakingTurn(harness: ReturnType<typeof makeLoop>, ws: FakeWs, messageId = 'msg_turn_1') {
    harness.stt.final('cuéntame el plan');
    await flush();
    const listener = (harness.loop as any).connections.values().next().value.listener;
    // Agent turn streams two text chunks (with messageId — the loop's tombstone key).
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId, chunkType: 'text_chunk', text: 'El plan tiene tres partes. ' }));
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId, chunkType: 'text_chunk', text: 'La primera es el despliegue.' }));
    // TTS audio starts flowing (2 chunks delivered = 380ms of audio).
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');
    harness.tts.deliverChunk('BBBB');
    return listener;
  }

  it('client interrupt frame → TTS cancelled immediately + interrupt frame back with the position', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    await openSpeakingTurn(harness, ws);

    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });

    expect(harness.tts.cancelled).toBe(1);
    const frame = ws.frames().find((f) => f.type === 'interrupt');
    expect(frame.playbackPositionMs).toBe(190);
    // The connection remembers what the user actually heard.
    const connectionId = (harness.loop as any).connections.keys().next().value;
    expect(harness.loop.getLastPlaybackPositionMs(connectionId)).toBe(190);
  });

  it('VAD server-side (onSpeechStart during speaking) → barge-in without any transcript', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    await openSpeakingTurn(harness, ws);

    // The user starts speaking — the STT fires onSpeechStart BEFORE any
    // interim/final transcript exists. Alice must cut immediately.
    harness.stt.speechStart();

    expect(harness.tts.cancelled).toBe(1);
    const frame = ws.frames().find((f) => f.type === 'interrupt');
    expect(frame).toBeDefined(); // server-side cut → position = everything delivered (380ms)
    expect(frame.playbackPositionMs).toBe(380);
  });

  it('VAD during idle (no TTS speaking) → NO barge-in (nothing to cut)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // User speaks while Alice is idle — no cut, no interrupt frame.
    harness.stt.speechStart();

    expect(harness.tts.cancelled).toBe(0);
    expect(ws.frames().some((f) => f.type === 'interrupt')).toBe(false);
  });

  it('late text chunks of the interrupted turn NEVER reopen the TTS (no audio overlap)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const listener = await openSpeakingTurn(harness, ws, 'msg_turn_1');

    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });

    // The interrupted turn keeps streaming late text chunks (the LLM had
    // already generated them / the boundary_aware interrupt lands at the
    // next boundary — chunks can still arrive).
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'msg_turn_1', chunkType: 'text_chunk', text: 'La segunda parte es el testing. ' }));

    // No new TTS stream, no new audio: the freeze holds.
    expect(harness.tts.cancelled).toBe(1); // not re-cancelled — nothing reopened
    expect(harness.tts.fed.length).toBe(2); // only the pre-interrupt feeds
    expect(ws.frames().filter((f) => f.type === 'tts_chunk').length).toBe(2); // audio stopped
    expect(ws.frames().some((f) => f.type === 'agent_response_delta' && f.text.includes('segunda parte'))).toBe(false);
  });

  it('the interrupting utterance enters the pipeline with the playback-position context attached', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    await openSpeakingTurn(harness, ws, 'msg_turn_1');

    // User cuts mid-response, then finishes the interrupting utterance.
    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });
    harness.stt.final('no, espera, la parte del despliegue');
    await flush();

    // Exactly two turns: the original + the interrupting one.
    expect(harness.agentTurns.length).toBe(2);
    const interruptingTurn = harness.agentTurns[1];
    // The turn text carries the barge-in context (what was heard + the no-repeat instruction).
    expect(interruptingTurn.text).toContain('no, espera, la parte del despliegue');
    expect(interruptingTurn.text).toContain('El plan tiene tres partes'); // heard text (proportional estimate)
    expect(interruptingTurn.text).toContain('No repitas lo no oído');

    // The context is consumed once — a later normal turn gets no stale note.
    harness.stt.final('otra pregunta normal');
    await flush();
    expect(harness.agentTurns.length).toBe(3);
    expect(harness.agentTurns[2].text).toBe('otra pregunta normal');
  });

  it('the barge-in note is LLM context only — no assistant message and no event row in the thread', async () => {
    // Pablo, PoC 2026-10-31: the bracketed note showed up in the chat as if
    // the agent had said it. It must ride the next turn's text (REQ-4) and
    // nothing else. The cut is recorded ON the interrupted reply
    // (metadata.voice) — the separate "Interrumpiste…" event row was dropped.
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    await openSpeakingTurn(harness, ws);

    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });
    await flush();

    const contextLine = harness.savedChannelMessages.find(
      (m: any) => typeof m.content?.text === 'string' && m.content.text.includes('interrumpió la respuesta hablada'),
    );
    expect(contextLine).toBeUndefined();
    const eventRow = harness.savedChannelMessages.find(
      (m: any) => m.content?.type === 'event' && m.content.eventType === 'voice_interrupted',
    );
    expect(eventRow).toBeUndefined();
  });

  it('double barge-in (client frame + VAD for the same cut) is idempotent', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    await openSpeakingTurn(harness, ws);

    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });
    harness.stt.speechStart(); // same physical interruption, second trigger

    // One cancel, one interrupt frame — the second trigger is a no-op.
    expect(harness.tts.cancelled).toBe(1);
    expect(ws.frames().filter((f) => f.type === 'interrupt').length).toBe(1);
  });

  it('the new turn after a barge-in CAN open a fresh TTS stream (freeze lifted)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const listener = await openSpeakingTurn(harness, ws, 'msg_turn_1');

    ws.receive({ type: 'interrupt', playbackPositionMs: 190 });

    // The interrupting utterance → new turn → new agent text chunks (new messageId).
    harness.stt.final('vale, perfecto');
    await flush();
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'msg_turn_2', chunkType: 'text_chunk', text: 'Perfecto, seguimos. ' }));

    // The new turn's text opened a NEW TTS stream (feed called again).
    expect(harness.tts.fed.length).toBe(3);
    // And the OLD turn's late chunks are still dead (tombstone by messageId).
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'msg_turn_1', chunkType: 'text_chunk', text: 'La segunda parte es el testing. ' }));
    expect(harness.tts.fed.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Latency budget (F1b, NFR-1) — per-segment + end-to-end percentiles
// ---------------------------------------------------------------------------

describe('VoiceLoop latency budget (F1b, NFR-1)', () => {
  it('records per-segment and end-to-end samples and derives p50/p95 with budget verdicts', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Complete turn: final → text chunks → audio → drain.
    harness.stt.final('pregunta');
    await flush();
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'Respuesta completa. ' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');
    harness.tts.callbacks!.onEnd(); // drains → recorded as a completed turn

    const stats = harness.loop.getLatencyStats();
    const e2e = stats.find((s) => s.segment === 'endToEnd')!;
    expect(e2e.count).toBe(1);
    expect(e2e.p50).not.toBeNull();
    expect(e2e.p95).not.toBeNull();
    // Mock timing is near-instant — well within the NFR budget.
    expect(e2e.p95WithinBudget).toBe(true);
    // All four segments have a sample.
    for (const s of stats) expect(s.count).toBe(1);
  });

  it('a barge-in turn counts toward the barge-in rate (REQ-11)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Turn 1: completed normally.
    harness.stt.final('primera');
    await flush();
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'Uno. ' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');
    harness.tts.callbacks!.onEnd();

    // Turn 2: barged in.
    harness.stt.final('segunda');
    await flush();
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm2', chunkType: 'text_chunk', text: 'Dos. ' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('BBBB');
    ws.receive({ type: 'interrupt', playbackPositionMs: 100 });

    expect(harness.loop.getBargeInRate()).toBe(0.5);
  });
});


// ---------------------------------------------------------------------------
// Session telemetry (F4, REQ-11/UC-12) — health record + persistence
// ---------------------------------------------------------------------------

describe('VoiceLoop session telemetry (F4, REQ-11/UC-12)', () => {
  it('counts turns, overheard, barge-ins and mode changes on the live record', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Overheard (passive, no vocative) → NOT a turn.
    harness.stt.final('pensando en voz alta sobre el despliegue');
    await flush();
    // Activated turn (vocative) → a turn.
    harness.stt.final('Alice, resume el fichero B.md');
    await flush();
    // Mode change by voice: passive → conversation (addressed — round 6: a
    // bare "hablemos" from an unaddressed room no longer switches anything).
    harness.stt.final('Alice, hablemos');
    await flush();

    const live = harness.loop.getLiveSessionTelemetry();
    expect(live.length).toBe(1);
    expect(live[0].turns).toBe(1);
    expect(live[0].overheard).toBe(1);
    expect(live[0].modeChanges).toBe(1); // passive → conversation
    // A spoken mode command is a META-ORDER: detected before the gate, it
    // switches the mode and returns — it is never a gate decision, so it is
    // not counted as an evaluated utterance. Only the two real utterances
    // (overheard + vocative turn) were evaluated, both in passive.
    expect(live[0].utterancesByMode.passive).toBe(2); // overheard + vocative turn
    // recordModeChange initializes the new mode's counter (0) — no utterance
    // was evaluated in conversation before the test ended.
    expect(live[0].utterancesByMode.conversation).toBe(0);
    expect(live[0].closedAt).toBeNull();
  });

  it('a resume of a live session counts as a reconnect; a stale record does not (NFR-3 evidence)', async () => {
    // Prior session still live (presence 'on') → this connection is a reconnect.
    const reconnectHarness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'conversation', presence: 'on', lastActivityAt: new Date() } },
    });
    await reconnectHarness.loop.handleConnection(new FakeWs() as any, 's1', 'agent1', undefined, 'ch_conv');
    expect(reconnectHarness.loop.getLiveSessionTelemetry()[0].reconnects).toBe(1);

    // Prior session went away hours ago (presence 'off', stale lastActivityAt) → fresh session.
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const freshHarness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive', presence: 'off', lastActivityAt: stale } },
    });
    await freshHarness.loop.handleConnection(new FakeWs() as any, 's1', 'agent1', undefined, 'ch_conv');
    expect(freshHarness.loop.getLiveSessionTelemetry()[0].reconnects).toBe(0);
  });

  it('STT errors are audio drops on the record — the session survives', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.error('Deepgram STT connection closed unexpectedly');

    const live = harness.loop.getLiveSessionTelemetry();
    expect(live[0].sttErrors).toBe(1);
    // The session did NOT die: the connection is still there.
    expect(harness.loop.getActiveConnectionsCount()).toBe(1);
    expect(live[0].closedAt).toBeNull();
  });

  it('TTS errors are audio drops on the record — the session survives', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Open a TTS stream (an agent turn), then kill it mid-flight.
    harness.stt.final('Alice, ¿qué hora es?');
    await flush();
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'Son las diez.' }));
    harness.tts.callbacks!.onStart();
    harness.tts.callbacks!.onError(new Error('TTS network down'));

    const live = harness.loop.getLiveSessionTelemetry();
    expect(live[0].ttsErrors).toBe(1);
    // The session did NOT die: the connection is still there.
    expect(harness.loop.getActiveConnectionsCount()).toBe(1);
    expect(live[0].closedAt).toBeNull();
  });

  it('cleanup seals the record and persists it to voice_telemetry_sessions', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    harness.stt.final('Alice, ¿qué hora es?');
    await flush();

    // Client disconnect → cleanup → sealed + persisted health record.
    for (const h of ws.handlers['close'] ?? []) h();
    await flush();

    expect(harness.telemetryUpserts.length).toBe(1);
    const upsert = harness.telemetryUpserts[0];
    expect(upsert.filter.recordId).toMatch(/^ch_conv:\d+$/);
    const record = upsert.update.$set;
    expect(record.channelId).toBe('ch_conv');
    expect(record.agentId).toBe('agent1');
    expect(record.userId).toBe('u1');
    expect(record.turns).toBe(1);
    expect(record.closedAt).not.toBeNull();
    // No live records left after cleanup.
    expect(harness.loop.getLiveSessionTelemetry().length).toBe(0);
  });

  it('the health summary carries latency, gate counters and the hour rollup (AC-9)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // One activated turn with audio (so the latency budget has a full sample).
    harness.stt.final('Alice, resume el fichero B.md');
    await flush();
    const listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'Claro. El fichero B trata de costes.' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');
    harness.tts.callbacks!.onEnd();

    const summary = harness.loop.getVoiceHealthSummary();
    expect(summary.activeConnections).toBe(1);
    expect(summary.bargeInRate).toBe(0);
    // Gate: one decision, activated by the vocative layer.
    expect(summary.gate.total).toBe(1);
    expect(summary.gate.activationsByLayer.vocative).toBe(1);
    // Latency: the end-to-end segment has a sample.
    const e2e = summary.latency.find((l: any) => l.segment === 'endToEnd');
    expect(e2e.count).toBe(1);
    // Hour rollup: one bucket with the same decision.
    expect(summary.gateHourly.buckets.length).toBe(1);
    expect(summary.gateHourly.buckets[0].byMode.conversation.evaluated).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Robustness — reconnection end-to-end consistency (F4, NFR-3, REQ-6)
// ---------------------------------------------------------------------------

describe('VoiceLoop reconnection consistency (F4, NFR-3, REQ-6)', () => {
  it('a reconnect restores the mode AND the thread has no duplicate user messages', async () => {
    // Seed: a live voice session in passive (the user switched mode, then
    // the connection dropped).
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive', presence: 'on', lastActivityAt: new Date() } },
    });
    const ws1 = new FakeWs();
    await harness.loop.handleConnection(ws1 as any, 's1', 'agent1', undefined, 'ch_conv');

    // One turn before the drop, so the thread has real content.
    harness.stt.final('Alice, resume el fichero B.md');
    await flush();
    expect(harness.savedChannelMessages.length).toBe(1); // the user's turn

    // The connection drops (network, not a user stop).
    for (const h of ws1.handlers['close'] ?? []) h();
    await flush();
    expect(harness.loop.getActiveConnectionsCount()).toBe(0);

    // The client reconnects (frontend backoff 1→16s, NFR-3) resuming the
    // same conversation channel.
    const ws2 = new FakeWs();
    await harness.loop.handleConnection(ws2 as any, 's2', 'agent1', undefined, 'ch_conv');

    // (a) The session is recognized as a RECONNECT (NFR-3 evidence).
    const live = harness.loop.getLiveSessionTelemetry();
    expect(live.length).toBe(1);
    expect(live[0].reconnects).toBe(1);

    // (b) The mode survived the reconnect (REQ-6): still passive, so a
    // non-vocative final is overheard, not a new turn (the one agent turn
    // is the pre-drop vocative turn).
    harness.stt.final('comentario al aire sobre el despliegue');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
    expect(harness.savedChannelMessages.length).toBe(2); // turn + overheard
    const touch = harness.voiceSessionUpdates.filter((u) => u.update.$set && !u.update.$setOnInsert).pop();
    expect(touch.update.$set.mode).toBe('passive');

    // (c) The thread has NO duplicates: each spoken utterance was persisted
    // exactly once across the drop (1 user turn + 1 overheard, distinct).
    const texts = harness.savedChannelMessages.map((m: any) => m.content.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toContain('Alice, resume el fichero B.md');
    expect(texts).toContain('comentario al aire sobre el despliegue');
  });

  it('an STT network error mid-session does not kill the session — the next utterance still works', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // The STT provider drops (network) — a typed error frame, not a close.
    harness.stt.error('Deepgram connection reset');
    await flush();

    // The session is still alive.
    expect(harness.loop.getActiveConnectionsCount()).toBe(1);

    // The next utterance flows through the pipeline normally.
    harness.stt.final('Alice, ¿se ha caído algo?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
    expect(harness.agentTurns[0].text).toContain('Alice, ¿se ha caído algo?');

    // And the drop is on the health record (audio drop, not session death).
    const live = harness.loop.getLiveSessionTelemetry();
    expect(live[0].sttErrors).toBe(1);
    expect(live[0].closedAt).toBeNull();
  });

  it('a TTS network error mid-turn does not kill the session — the next turn still speaks', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');

    // Turn 1: the agent's TTS stream dies mid-flight.
    harness.stt.final('Alice, dime algo');
    await flush();
    let listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'Claro.' }));
    harness.tts.callbacks!.onStart();
    harness.tts.callbacks!.onError(new Error('TTS stream reset'));

    // The session survived.
    expect(harness.loop.getActiveConnectionsCount()).toBe(1);

    // Turn 2: a fresh turn speaks normally.
    harness.stt.final('Alice, repítemelo');
    await flush();
    listener = (harness.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm2', chunkType: 'text_chunk', text: 'Otra vez.' }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('BBBB');
    harness.tts.callbacks!.onEnd();

    const audio = ws.frames().filter((f) => f.type === 'tts_chunk');
    expect(audio.length).toBeGreaterThan(0);

    // And the drop is on the health record.
    const live = harness.loop.getLiveSessionTelemetry();
    expect(live[0].ttsErrors).toBe(1);
    expect(live[0].closedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F5h — playback_ended protocol: the barge-in window covers REAL playback
// ---------------------------------------------------------------------------

describe('VoiceLoop F5h — barge-in window until true playback end', () => {
  /**
   * Open a TTS stream, deliver two chunks (380ms of audio), and close the
   * SEND side (the provider's onEnd). The client is still holding buffered
   * audio at this point — everything after this is the F5h window.
   */
  async function speakAndSendEnd(harness: ReturnType<typeof makeLoop>) {
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (harness.loop as any).connections.values().next().value;
    connection.listener(JSON.stringify({
      type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'hablando...',
    }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA'); // 190ms
    harness.tts.deliverChunk('BBBB'); // 380ms delivered in total
    harness.tts.end(); // send-end — the provider finished SENDING (and went inactive, like the real one)
    return { ws, connection };
  }

  it('send-end keeps ttsActive armed (the bug: it used to drop here) + arms the safety timer + emits speaking_ended', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { ws, connection } = await speakAndSendEnd(harness);

    // THE F5h invariant: the client still holds the buffered audio — the
    // barge-in window must stay open past the provider's send-end.
    expect(connection.ttsActive).toBe(true);
    expect(connection.playbackSafetyTimer).not.toBe(null); // armed

    // speaking_ended still goes out at send-end (the client flushes its
    // last sentence on it — moving it would drop the turn's last sentence).
    expect(ws.frames().some((f) => f.type === 'speaking_ended')).toBe(true);
  });

  it('playback_ended (client drain) → ttsActive false + safety timer cleared', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { ws, connection } = await speakAndSendEnd(harness);

    ws.receive({ type: 'playback_ended' });

    expect(connection.ttsActive).toBe(false);
    expect(connection.playbackSafetyTimer).toBe(null);
  });

  it('safety timeout (client never drains) closes the window — no zombie session', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { connection } = await speakAndSendEnd(harness);
    const connectionId = (harness.loop as any).connections.keys().next().value;

    expect(connection.playbackSafetyTimer).not.toBe(null); // armed at send-end

    // Drive the timeout path directly (deterministic — same pattern as the
    // F5b filler tests; the real timer waits ttsTotalMs + margin).
    (harness.loop as any).closePlaybackWindow(connectionId, 'test');

    expect(connection.ttsActive).toBe(false);
    expect(connection.playbackSafetyTimer).toBe(null);
  });

  it('VAD barge-in DURING the playback window (after send-end) cuts and counts bargeInsVad — the live bug', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { ws, connection } = await speakAndSendEnd(harness);

    // The user is still HEARING buffered audio when the VAD fires — the
    // exact scenario that failed live (session 17:08: bargeInsVad=0).
    harness.stt.speechStart();

    expect(connection.turnFrozen).toBe(true); // the cut landed
    const frame = ws.frames().find((f) => f.type === 'interrupt');
    expect(frame).toBeTruthy(); // the client is told to stop NOW
    const live = harness.loop.getLiveSessionTelemetry();
    expect(live[0].bargeInsVad).toBe(1); // telemetry sees it (was 0 live)
    // The window closed with the cut — no zombie timer left behind.
    expect(connection.playbackSafetyTimer).toBe(null);
    expect(connection.ttsActive).toBe(false);
  });

  it('VAD barge-in during SEND still fires (no regression — the pre-F5h path)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = new FakeWs();
    await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    const connection = (harness.loop as any).connections.values().next().value;
    connection.listener(JSON.stringify({
      type: 'message_chunk', channelId: 'ch_conv', messageId: 'm1', chunkType: 'text_chunk', text: 'hablando...',
    }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('AAAA');

    harness.stt.speechStart(); // mid-send interruption

    expect(connection.turnFrozen).toBe(true);
    expect(harness.loop.getLiveSessionTelemetry()[0].bargeInsVad).toBe(1);
  });

  it('stale playback_ended after a barge-in is a no-op (epoch guard)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { ws, connection } = await speakAndSendEnd(harness);

    harness.stt.speechStart(); // barge-in closes the window (timer cleared)

    // A late/stale drain edge arrives — it must not resurrect or corrupt
    // the cut state (no timer armed → no epoch expects it).
    ws.receive({ type: 'playback_ended' });

    expect(connection.turnFrozen).toBe(true); // the cut stands
    expect(connection.ttsActive).toBe(false);
  });

  it('stale playback_ended while a NEW turn is mid-send does not drop the new window', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const { ws, connection } = await speakAndSendEnd(harness);
    ws.receive({ type: 'playback_ended' }); // epoch 1 closed cleanly

    // Epoch 2: the user speaks again → a fresh turn, a fresh stream.
    harness.stt.final('otra cosa');
    await flush();
    connection.listener(JSON.stringify({
      type: 'message_chunk', channelId: 'ch_conv', messageId: 'm2', chunkType: 'text_chunk', text: 'segundo turno',
    }));
    harness.tts.callbacks!.onStart();
    harness.tts.deliverChunk('CCCC'); // epoch 2 mid-send

    // A stale playback_ended (duplicated drain edge of epoch 1) arrives —
    // epoch 2's window must stay armed (its timer is not armed yet: the
    // legit drain of epoch 2 can only arrive after its own onEnd).
    ws.receive({ type: 'playback_ended' });

    expect(connection.ttsActive).toBe(true); // epoch 2 still armed
  });
});
