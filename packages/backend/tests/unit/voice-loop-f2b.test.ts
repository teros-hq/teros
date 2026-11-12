/**
 * Voice Mode v2 — F2b suite (spec v1.1.0, REQ-6/REQ-8/REQ-9, AC-3/AC-4b/AC-6/AC-7).
 *
 * Covers, with the same harness pattern as the F1a/F1b/F2a suites (mocked
 * STT/TTS providers, stub constructor deps, private methods via `(loop as any)`):
 *
 *  1. Spoken mode commands (REQ-6 — the voice door):
 *     - "ponte en modo silencio" → passive + spoken ack "Vale." + mode_changed {source:'voice'}
 *     - "hablemos" → conversation + ack "Dime."
 *     - "Alice, vuelve" (vocative, from passive) → conversation + ack "Dime."
 *     - the command NEVER spends an agent turn (meta-order, not a turn)
 *     - narration about modes ("estábamos en modo silencio y…") does NOT switch
 *     - the command works from ANY mode (passive included — addressed to the session)
 *
 *  2. Mode persistence (REQ-6 — always-on, AC-6):
 *     - the mode change persists to voice_sessions (touch carries the new mode)
 *     - reconnect restores the persisted mode (passive stays passive)
 *     - default on first activation is `conversation` (decisión de Pablo #4)
 *
 *  3. Overheard session memory (REQ-9 — decisión de Pablo #5):
 *     - non-activated utterances accumulate (buffer) and ride the NEXT activated
 *       turn as context (the agent can answer "¿qué hemos hablado?")
 *     - the buffer is consumed once (the next-next turn carries no stale note)
 *     - the overheard row is still persisted visible-tenue (overheard:true, source:'voice')
 *
 *  4. Agent mode tools (REQ-8 — the agent's own door, AC-7):
 *     - set_mode/get_mode/pause_listening definitions injected ONLY with an
 *       active session (session-scoped, text chat has no mode axis)
 *     - setVoiceSessionMode broadcasts mode_changed {source:'system'} and persists
 *     - pauseVoiceSessionListening → passive + auto-return timer to conversation
 *       (mock timers), cleared by any later mode change
 *
 *  5. Presence receipt data (UC-11): the session record keeps startedAt/endedAt
 *     across the presence stretch — the frontend's PresenceDivider renders from
 *     these; the backend's job is to not lose them (always-on, REQ-5).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';
import { parseVoiceModeCommand } from '../../src/services/voice-mode-commands';
import {
  buildVoiceModeToolDefinitions,
  isVoiceModeTool,
} from '../../src/services/voice-mode-tools';
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
  close = () => {
    if (this.closed) return; // like the real ws — close is idempotent
    this.closed = true;
    // The real WebSocket emits a 'close' event — fire the registered handlers
    // so the loop's cleanup (closeVoiceSession, REQ-6/UC-11) runs like in prod.
    for (const h of this.handlers['close'] ?? []) h();
  };
  on = (event: string, handler: (data?: any) => void) => {
    (this.handlers[event] ??= []).push(handler);
  };
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
// Harness (same shape as the F1a suite)
// ---------------------------------------------------------------------------

function makeLoop(opts: {
  channels?: Record<string, any>;
  agents?: Record<string, any>;
  voiceSessions?: Record<string, any>;
} = {}) {
  const channels = opts.channels ?? {
    ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  };
  const agents = opts.agents ?? { agent1: { agentId: 'agent1', name: 'Alice', workspaceId: 'ws1' } };
  const voiceSessions = opts.voiceSessions ?? {};
  const voiceSessionUpdates: any[] = [];
  const savedChannelMessages: any[] = [];
  const broadcasts: any[] = [];
  const agentTurns: Array<{ channelId: string; agentId: string; text: string }> = [];

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
          // Emulate the upsert store so a later findOne sees the touched mode.
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
    broadcastToTopic(topic: string, event: any) { broadcasts.push({ topic, event }); },
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

  return { loop, stt, tts, agentTurns, savedChannelMessages, voiceSessionUpdates, broadcasts };
}

const CHANNELS = {
  ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
};

async function connect(harness: ReturnType<typeof makeLoop>) {
  const ws = new FakeWs();
  await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
  return ws;
}

async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------
// 1. parseVoiceModeCommand — the pure parser (REQ-6 vocabulary)
// ---------------------------------------------------------------------------

describe('parseVoiceModeCommand (REQ-6 — UX §2.3 vocabulary)', () => {
  it('recognizes the canonical passive commands', () => {
    expect(parseVoiceModeCommand('Ponte en modo silencio', 'Alice')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('ponte en modo escucha', 'Alice')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('modo silencio', 'Alice')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('solo escucha', 'Alice')?.mode).toBe('passive');
    expect(parseVoiceModeCommand('escucha sin hablar', 'Alice')?.mode).toBe('passive');
  });

  it('recognizes the canonical conversation commands', () => {
    expect(parseVoiceModeCommand('hablemos', 'Alice')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('modo conversación', 'Alice')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('Alice, hablemos', 'Alice')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('volvamos a hablar', 'Alice')?.mode).toBe('conversation');
  });

  it('recognizes the recovery door from passive ("vuelve" → conversation, two modes only)', () => {
    expect(parseVoiceModeCommand('Alice, vuelve', 'Alice')?.mode).toBe('conversation');
    expect(parseVoiceModeCommand('regresa conmigo', 'Alice')?.mode).toBe('conversation');
  });

  it('strips an optional vocative prefix ("Alice, modo silencio")', () => {
    const cmd = parseVoiceModeCommand('Alice, modo silencio', 'Alice');
    expect(cmd?.mode).toBe('passive');
  });

  it('gives the canonical ack per mode (UX §5.1/§5.2)', () => {
    expect(parseVoiceModeCommand('ponte en modo silencio', 'Alice')?.ack).toBe('Vale.');
    expect(parseVoiceModeCommand('hablemos', 'Alice')?.ack).toBe('Dime.');
    expect(parseVoiceModeCommand('Alice, vuelve', 'Alice')?.ack).toBe('Dime.');
  });

  it('does NOT match narration about modes (anchored matching)', () => {
    expect(parseVoiceModeCommand('estábamos en modo silencio y luego cambió', 'Alice')).toBeNull();
    expect(parseVoiceModeCommand('le comenté que el modo atención es el mejor', 'Alice')).toBeNull();
    expect(parseVoiceModeCommand('¿y si habláramos de otro tema?', 'Alice')).toBeNull();
  });

  it('returns null for ordinary speech', () => {
    expect(parseVoiceModeCommand('¿y el pico de agosto?', 'Alice')).toBeNull();
    expect(parseVoiceModeCommand('Alice, resume el fichero B.md', 'Alice')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The voice door — spoken mode commands in the loop (REQ-6, AC-3/AC-4b)
// ---------------------------------------------------------------------------

describe('VoiceLoop spoken mode commands (F2b — the voice door)', () => {
  it('"ponte en modo silencio" → passive, spoken ack, mode_changed {source:"voice"}, NO agent turn', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    harness.stt.final('Ponte en modo silencio');
    await flush();

    // Meta-order: no agent turn spent.
    expect(harness.agentTurns.length).toBe(0);
    // The authoritative frame.
    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame).toEqual({ type: 'mode_changed', mode: 'passive', source: 'voice' });
    // The spoken ack (UX §5.1: "Vale.") via TTS.
    expect(harness.tts.fed).toContain('Vale.');
    expect(harness.tts.endOfTextCount).toBeGreaterThan(0);
  });

  it('the mode took effect: the next non-vocative utterance is overheard', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    harness.stt.final('Ponte en modo silencio');
    await flush();
    harness.stt.final('hablando con otra persona');
    await flush();

    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages.at(-1)?.overheard).toBe(true);
  });

  it('"Alice, hablemos" → conversation with ack "Dime." (AC-4b: back from passive; round 6: addressed)', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = await connect(harness);

    harness.stt.final('Alice, hablemos');
    await flush();

    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame.mode).toBe('conversation');
    expect(harness.tts.fed).toContain('Dime.');

    // And conversation responds to everything again.
    harness.stt.final('¿y el pico de agosto?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
  });

  it('"Alice, vuelve" from passive → conversation with ack "Dime."', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = await connect(harness);

    harness.stt.final('Alice, vuelve');
    await flush();

    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame.mode).toBe('conversation');
    expect(harness.tts.fed).toContain('Dime.');
    expect(harness.agentTurns.length).toBe(0);
  });

  it('a spoken command works from passive WITHOUT the vocative (addressed to the session)', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = await connect(harness);

    harness.stt.final('modo conversación');
    await flush();

    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame.mode).toBe('conversation');
    expect(harness.agentTurns.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Mode persistence + always-on (REQ-6/REQ-5, AC-6)
// ---------------------------------------------------------------------------

describe('VoiceLoop mode persistence (F2b — always-on, AC-6)', () => {
  it('a spoken mode change persists to voice_sessions (the touch carries the new mode)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    await connect(harness);

    harness.stt.final('Ponte en modo silencio');
    await flush();

    const touches = harness.voiceSessionUpdates.filter((u) => u.update.$set && !u.update.$setOnInsert);
    expect(touches.at(-1)?.update.$set.mode).toBe('passive');
  });

  it('reconnect restores the persisted mode (passive survives, AC-6)', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = await connect(harness);

    // Restored passive: a plain utterance is overheard, not a turn.
    harness.stt.final('comentario al aire');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);

    // And the upsert re-persists the restored mode.
    const upsert = harness.voiceSessionUpdates.find((u) => u.update.$setOnInsert);
    expect(upsert.update.$set.mode).toBe('passive');
  });

  it('default on first activation is conversation (decisión de Pablo #4, AC-4b)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    await connect(harness);

    const upsert = harness.voiceSessionUpdates.find((u) => u.update.$setOnInsert);
    expect(upsert.update.$set.mode).toBe('conversation');
    expect(upsert.update.$set.presence).toBe('on');
  });

  it('the session record keeps startedAt/endedAt across the stretch (UC-11 receipt data)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    const upsert = harness.voiceSessionUpdates.find((u) => u.update.$setOnInsert);
    expect(upsert.update.$setOnInsert.startedAt).toBeInstanceOf(Date);

    // Close (presence off) — the receipt's end anchor. closeVoiceSession is
    // fire-and-forget from the ws close handler; poll briefly for it (the
    // suite's flush is a fixed 5ms, not enough under load).
    ws.close();
    let close: any;
    for (let i = 0; i < 50; i++) {
      await flush();
      close = harness.voiceSessionUpdates
        .filter((u) => u.update.$set?.presence === 'off')
        .at(-1);
      if (close) break;
    }
    expect(close).toBeDefined();
    expect(close.update.$set.endedAt).toBeInstanceOf(Date);
    // The mode survives the close — it is restored on the next connect.
    expect(close.update.$set.mode).toBe('conversation');
  });
});

// ---------------------------------------------------------------------------
// 4. Overheard session memory (REQ-9 — decisión de Pablo #5)
// ---------------------------------------------------------------------------

describe('VoiceLoop overheard session memory (F2b, REQ-9)', () => {
  it('overheard utterances ride the NEXT activated turn as context', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    await connect(harness);

    // Two overheard utterances while in passive.
    harness.stt.final('el informe de agosto va bien');
    await flush();
    harness.stt.final('pero el pico de septiembre preocupa');
    await flush();

    // The vocative opens a turn — the overheard context rides it.
    harness.stt.final('Alice, ¿qué hemos hablado?');
    await flush();

    expect(harness.agentTurns.length).toBe(1);
    const turnText = harness.agentTurns[0].text;
    expect(turnText).toContain('Alice, ¿qué hemos hablado?');
    expect(turnText).toContain('el informe de agosto va bien');
    expect(turnText).toContain('pero el pico de septiembre preocupa');
  });

  it('the overheard context is consumed once — no stale note on later turns', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    await connect(harness);

    harness.stt.final('algo overheard');
    await flush();
    harness.stt.final('Alice, primera pregunta');
    await flush();
    harness.stt.final('Alice, segunda pregunta');
    await flush();

    expect(harness.agentTurns.length).toBe(2);
    expect(harness.agentTurns[0].text).toContain('algo overheard');
    expect(harness.agentTurns[1].text).not.toContain('algo overheard');
  });

  it('overheard rows persist visible-tenue (overheard:true, source:"voice")', async () => {
    const harness = makeLoop({
      channels: CHANNELS,
      voiceSessions: { 'ch_conv:agent1': { mode: 'passive' } },
    });
    const ws = await connect(harness);

    harness.stt.final('una frase no dirigida');
    await flush();

    const row = harness.savedChannelMessages.at(-1);
    expect(row.overheard).toBe(true);
    expect(row.source).toBe('voice');
    const frame = ws.frames().find((f) => f.type === 'transcript' && f.overheard);
    expect(frame).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Agent mode tools (REQ-8, AC-7)
// ---------------------------------------------------------------------------

describe('VoiceLoop agent mode tools (F2b, REQ-8)', () => {
  it('the tool definitions are the spec trio (set_mode/get_mode/pause_listening)', () => {
    const defs = buildVoiceModeToolDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(['get_mode', 'pause_listening', 'set_mode']);
    expect(isVoiceModeTool('set_mode')).toBe(true);
    expect(isVoiceModeTool('list-app-tools')).toBe(false);
  });

  it('setVoiceSessionMode broadcasts mode_changed {source:"system"} and persists (the agent door)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    const applied = harness.loop.setVoiceSessionMode('ch_conv', 'agent1', 'passive');
    expect(applied).toBe('passive');

    const frame = ws.frames().find((f) => f.type === 'mode_changed');
    expect(frame).toEqual({ type: 'mode_changed', mode: 'passive', source: 'system' });

    const touches = harness.voiceSessionUpdates.filter((u) => u.update.$set && !u.update.$setOnInsert);
    expect(touches.at(-1)?.update.$set.mode).toBe('passive');
  });

  it('getVoiceSessionMode reads the live mode; isVoiceSessionActive is session-scoped', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    await connect(harness);

    expect(harness.loop.isVoiceSessionActive('ch_conv', 'agent1')).toBe(true);
    expect(harness.loop.isVoiceSessionActive('ch_conv', 'agent_other')).toBe(false);
    expect(harness.loop.isVoiceSessionActive('ch_none', 'agent1')).toBe(false);
    expect(harness.loop.getVoiceSessionMode('ch_conv', 'agent1')).toBe('conversation');

    harness.loop.setVoiceSessionMode('ch_conv', 'agent1', 'passive');
    expect(harness.loop.getVoiceSessionMode('ch_conv', 'agent1')).toBe('passive');
  });

  it('pauseVoiceSessionListening → passive now, conversation when it elapses (AC-7)', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    const minutes = harness.loop.pauseVoiceSessionListening('ch_conv', 'agent1', 30);
    expect(minutes).toBe(30);

    // Immediately passive.
    const frames = ws.frames().filter((f) => f.type === 'mode_changed');
    expect(frames.at(-1)).toEqual({ type: 'mode_changed', mode: 'passive', source: 'system' });

    // Elapse the pause — drive the timer callback directly (deterministic,
    // the suite's convention: no timer mocking in the harness).
    const connectionId = (harness.loop as any).connections.keys().next().value as string;
    (harness.loop as any).onPauseElapsed(connectionId);
    const restored = ws.frames().filter((f) => f.type === 'mode_changed').at(-1);
    expect(restored).toEqual({ type: 'mode_changed', mode: 'conversation', source: 'system' });
  });

  it('a later mode change cancels the pending pause auto-return', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    const ws = await connect(harness);

    harness.loop.pauseVoiceSessionListening('ch_conv', 'agent1', 30);
    // The user speaks before the pause elapses.
    harness.stt.final('Alice, hablemos');
    await flush();

    const connectionId = (harness.loop as any).connections.keys().next().value as string;
    (harness.loop as any).onPauseElapsed(connectionId);
    const modes = ws.frames().filter((f) => f.type === 'mode_changed').map((f) => f.mode);
    // passive (pause) → conversation (spoken) → NO third flip (the elapsed
    // callback is a no-op: the user already changed the mode).
    expect(modes).toEqual(['passive', 'conversation']);
  });

  it('pause clamps the duration to 1–480 minutes', async () => {
    const harness = makeLoop({ channels: CHANNELS });
    await connect(harness);

    expect(harness.loop.pauseVoiceSessionListening('ch_conv', 'agent1', 0)).toBe(1);
    expect(harness.loop.pauseVoiceSessionListening('ch_conv', 'agent1', 9999)).toBe(480);
    expect(harness.loop.pauseVoiceSessionListening('ch_none', 'agent1', 5)).toBeNull();
  });
});
