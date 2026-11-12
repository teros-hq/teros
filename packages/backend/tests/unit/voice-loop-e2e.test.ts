/**
 * Voice Mode v2 — F4 E2E suite: a full session lifecycle over the mock
 * STT/TTS providers (spec §Fase 4: "suite E2E de voz").
 *
 * One describe = ONE session walked end to end, in spec order:
 *   activate → speak → response → barge-in → mode change (voice + UI) →
 *   overheard → delegation (tool_call frames) → deactivate.
 *
 * The harness is the same FakeWs/MockStt/MockTts pattern as voice-loop.test.ts
 * (kept deliberately small — this file asserts the FLOW, the details are
 * covered by the focused suites).
 */
import { describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';

// ---------------------------------------------------------------------------
// Mocks (same contracts as voice-loop.test.ts)
// ---------------------------------------------------------------------------

class FakeWs {
  sent: any[] = [];
  handlers: Record<string, Array<(data?: any) => void>> = {};
  readyState = 1; // OPEN
  send(data: string) { this.sent.push(JSON.parse(data)); }
  on(event: string, cb: (data?: any) => void) {
    (this.handlers[event] ??= []).push(cb);
  }
  close() { this.closed = true; } // flag only — the loop closes back (no re-fire)
  /** Test helper: simulate the socket closing (fires the loop's cleanup). */
  disconnect() { for (const h of this.handlers['close'] ?? []) h(); }
  /** Route a client frame into the loop (as the real WS would). */
  receive(payload: object) {
    for (const h of this.handlers['message'] ?? []) h(Buffer.from(JSON.stringify(payload)));
  }
  frames() { return this.sent; }
  framesOf(type: string) { return this.sent.filter((f) => f.type === type); }
}

class MockStt {
  callbacks: any = null;
  connect(_cb: any) { this.callbacks = _cb; }
  sendAudio(_b64: string) {}
  close() {}
  interim(_t: string) { this.callbacks?.onInterim?.(_t); }
  final(t: string) { this.callbacks?.onFinal?.(t); }
  error(msg: string) { this.callbacks?.onError?.(msg); }
  speechStart() { this.callbacks?.onSpeechStart?.(); }
}

class MockTts {
  callbacks: any = null;
  speak(callbacks: any) { this.callbacks = callbacks; }
  feed(_t: string) {}
  endOfText() {}
  cancel() {}
  isSpeaking() { return false; }
  deliverChunk(b64 = 'QUJD') { this.callbacks?.onChunk?.(b64); }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeHarness() {
  const savedChannelMessages: any[] = [];
  const broadcasts: any[] = [];
  const voiceSessionUpdates: any[] = [];
  const telemetryUpserts: any[] = [];
  const agentTurns: Array<{ channelId: string; agentId: string; text: string; onComplete?: () => void }> = [];

  const db = {
    collection: (name: string) => {
      if (name === 'channels') {
        return {
          findOne: async () => ({ channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1' }),
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
        };
      }
      if (name === 'agents') return { findOne: async () => ({ agentId: 'agent1', name: 'Alice', workspaceId: 'ws1' }) };
      if (name === 'voice_sessions') {
        return {
          updateOne: async (filter: any, update: any) => { voiceSessionUpdates.push({ filter, update }); return { matchedCount: 1 }; },
          findOne: async () => null,
        };
      }
      if (name === 'voice_telemetry_sessions') {
        return {
          updateOne: async (filter: any, update: any) => { telemetryUpserts.push({ filter, update }); return { matchedCount: 1 }; },
          find: () => ({ toArray: async () => [] }),
        };
      }
      if (name === 'channel_messages') {
        return {
          insertOne: async (doc: any) => { savedChannelMessages.push(doc); },
          // Real Mongo signature: find(query, { sort, limit }) → cursor.toArray()
          find: (_q: any, _opts?: any) => ({
            sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
            toArray: async () => [],
          }),
        };
      }
      return { findOne: async () => null, find: (_q: any, _opts?: any) => ({ toArray: async () => [] }) };
    },
  } as any;

  const channelManager = {
    getChannel: async (id: string) => (id === 'ch_conv' ? { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1' } : null),
    createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async (m: any) => { savedChannelMessages.push(m); },
  } as any;

  const pubSubService = {
    addListener() {},
    removeListener() {},
    broadcastToTopic(topic: string, event: any) { broadcasts.push({ topic, event }); },
  } as any;

  const authService = { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) } as any;
  const workspaceService = { canAccess: async () => true } as any;

  const messageHandler = {
    processAgentResponse: async (channelId: string, agentId: string, text: string, _messageId?: string, onComplete?: () => void) => {
      agentTurns.push({ channelId, agentId, text, onComplete });
    },
  } as any;

  const stt = new MockStt();
  const tts = new MockTts();

  const loop = new VoiceLoop(
    db,
    channelManager,
    {} as any,
    messageHandler,
    workspaceService,
    null,
    authService,
    { sttFactory: () => stt, ttsFactory: () => tts },
  );
  loop.setPubSubService(pubSubService);

  return { loop, stt, tts, agentTurns, savedChannelMessages, broadcasts, voiceSessionUpdates, telemetryUpserts };
}

/** Drive the agent side of one turn: chunks → TTS stream → end (async-safe). */
async function speakAgentTurn(harness: ReturnType<typeof makeHarness>, messageId: string, text: string) {
  const listener = (harness.loop as any).connections.values().next().value.listener;
  listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId, chunkType: 'text_chunk', text }));
  await flush(); // the loop opens the TTS stream on the first chunk (async)
  harness.tts.callbacks!.onStart();
  harness.tts.deliverChunk();
  harness.tts.callbacks!.onEnd();
  await flush();
}

// ---------------------------------------------------------------------------
// The session — one it() = the whole lifecycle (that is the point of E2E)
// ---------------------------------------------------------------------------

describe('VoiceLoop E2E — full session lifecycle (F4, spec §Fase 4)', () => {
  it('activate → speak → response → barge-in → mode change (voice+UI) → overheard → delegation → deactivate', async () => {
    const h = makeHarness();
    const ws = new FakeWs();

    // --- 1. ACTIVATE: connect to the conversation channel. ---
    await h.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
    // The session channel frame (F0: voice lives in the conversation channel).
    const channelFrame = ws.framesOf('voice_channel');
    expect(channelFrame.length).toBe(1);
    expect(channelFrame[0].channelId).toBe('ch_conv');
    expect(channelFrame[0].isResuming).toBe(true); // a channel resume (voice lives in the chat channel)
    expect(h.loop.getActiveConnectionsCount()).toBe(1);

    // --- 2. SPEAK: an activated turn (vocative). ---
    h.stt.final('Alice, resume el fichero B.md');
    await flush();
    expect(h.agentTurns.length).toBe(1);
    // The spoken turn is in the unified thread (source: voice).
    expect(h.savedChannelMessages.length).toBe(1);
    expect(h.savedChannelMessages[0].source).toBe('voice');
    expect(h.savedChannelMessages[0].content.text).toBe('Alice, resume el fichero B.md');

    // --- 3. RESPONSE: the agent speaks (chunks → TTS → frames). ---
    await speakAgentTurn(h, 'm1', 'Claro. El fichero B resume los costes.');
    // The audio path: tts_chunk frames carry the spoken response.
    const audio = ws.framesOf('tts_chunk');
    expect(audio.length).toBeGreaterThan(0);
    // And the text deltas reached the client too (unified transcript).
    expect(ws.framesOf('agent_response_delta').length).toBeGreaterThan(0);

    // --- 4. BARGE-IN: the user interrupts the next response mid-flight. ---
    h.stt.final('Alice, espera, cambia la sección de costes');
    await flush();
    // The agent's turn streams (audio flowing, NOT yet finished — a barge-in
    // cuts a response in flight).
    const listener = (h.loop as any).connections.values().next().value.listener;
    listener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm2', chunkType: 'text_chunk', text: 'Vale, la sección de costes dice que…' }));
    await flush();
    h.tts.callbacks!.onStart();
    h.tts.deliverChunk(); // audio flowing…
    ws.receive({ type: 'interrupt', playbackPositionMs: 120 });
    // The barge-in is recorded (client path) and the TTS is cancelled.
    expect(h.loop.getBargeInRate()).toBeGreaterThan(0);
    const live = h.loop.getLiveSessionTelemetry();
    expect(live[0].bargeInsClient).toBe(1);
    // The cut is acked to the client with the authoritative position.
    const interruptAck = ws.framesOf('interrupt');
    expect(interruptAck.length).toBe(1);
    expect(interruptAck[0].playbackPositionMs).toBe(120);

    // --- 5. MODE CHANGE by VOICE: "ponte en modo silencio". ---
    h.stt.final('ponte en modo silencio');
    await flush();
    const changedByVoice = ws.framesOf('mode_changed');
    expect(changedByVoice.length).toBe(1);
    expect(changedByVoice[0].mode).toBe('passive');
    expect(changedByVoice[0].source).toBe('voice');
    // The mode command is a META-ORDER: no agent turn was spent.
    expect(h.agentTurns.length).toBe(2); // the two turns above, not this one

    // --- 6. OVERHEARD: in passive, a non-vocative final is not a turn. ---
    h.stt.final('comentario al aire sobre el despliegue');
    await flush();
    expect(h.agentTurns.length).toBe(2); // unchanged
    const transcripts = ws.framesOf('transcript');
    const overheardFrame = transcripts.find((f) => f.overheard === true);
    expect(overheardFrame).toBeDefined();
    expect(overheardFrame!.text).toBe('comentario al aire sobre el despliegue');
    // And it is persisted to the thread (visible-tenue). 3 messages by now:
    // turn 1 + turn 2 + this overheard line (PoC 2026-10-31: the barge-in
    // leaves NO row of its own — the cut is recorded on the interrupted reply).
    expect(h.savedChannelMessages.length).toBe(3);

    // --- 7. MODE CHANGE by UI: back to conversation (the picker door). ---
    ws.receive({ type: 'set_mode', mode: 'conversation' });
    await flush();
    const changedByUi = ws.framesOf('mode_changed');
    expect(changedByUi.length).toBe(2);
    expect(changedByUi[1].mode).toBe('conversation');
    expect(changedByUi[1].source).toBe('ui');

    // --- 8. DELEGATION: the agent's turn emits tool_call frames. ---
    h.stt.final('Alice, pausa la escucha un rato');
    await flush();
    expect(h.agentTurns.length).toBe(3);
    const delegationListener = (h.loop as any).connections.values().next().value.listener;
    delegationListener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm3', chunkType: 'tool_call_start', toolName: 'pause_listening' }));
    delegationListener(JSON.stringify({ type: 'message_chunk', channelId: 'ch_conv', messageId: 'm3', chunkType: 'tool_call_complete', toolName: 'pause_listening' }));
    const toolFrames = ws.framesOf('tool_call');
    expect(toolFrames.length).toBe(1);
    expect(toolFrames[0].toolName).toBe('pause_listening');

    // --- 9. DEACTIVATE: the socket closes → session sealed + persisted. ---
    ws.disconnect();
    await flush();
    expect(h.loop.getActiveConnectionsCount()).toBe(0);
    expect(h.loop.getLiveSessionTelemetry().length).toBe(0);
    // The health record was sealed and persisted (voice_telemetry_sessions).
    expect(h.telemetryUpserts.length).toBe(1);
    const record = h.telemetryUpserts[0].update.$set;
    expect(record.turns).toBe(3);
    expect(record.overheard).toBe(1);
    expect(record.modeChanges).toBe(2); // voice + UI
    expect(record.bargeInsClient).toBe(1);
    expect(record.closedAt).not.toBeNull();
    // The persistent session record closed (presence off).
    const closeUpdate = h.voiceSessionUpdates.filter((u) => u.update.$set?.presence === 'off').pop();
    expect(closeUpdate).toBeDefined();
    expect(closeUpdate.update.$set.mode).toBe('conversation');
  });
});
