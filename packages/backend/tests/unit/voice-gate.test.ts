/**
 * Voice Mode v2 — F2a tests: the invocation gate (spec v1.1.0 REQ-7,
 * AC-3/AC-4/AC-4b, §edge cases, UC-12).
 *
 * Coverage, by acceptance criterion:
 *
 *  1. Layer 1 — vocative (ALL modes): leading / near-start / trailing / bare
 *     hail / STT spelling variants; third-person mentions never fire.
 *  2. Layer 2 — REMOVED with the `attention` mode (Pablo 2026-10-05,
 *     a527c2a9c): two modes only. Passive opens on the vocative alone and
 *     no decision carries a classifier score.
 *  3. Layer 3 — conversation: everything is a turn; the voice-session context
 *     note rides the first turn (the system-prompt door) and is consumed once.
 *  4. Overheard persistence (REQ-9): non-activated utterances persist with
 *     overheard:true + broadcast — nothing is lost (F2b renders them).
 *  5. Telemetry (REQ-11/UC-12): every decision is logged with mode, layer,
 *     score, activated; counters aggregate per mode/layer.
 *  6. Edge cases (§edge cases + "invocación con ruido"): noisy STT variants,
 *     short/garbage utterances, diacritics, mode switching mid-session,
 *     dialogue-state reset on mode change.
 *
 * Same harness as voice-loop.test.ts (FakeWs + MockStt/MockTts + stub deps).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';
import {
  evaluateInvocationGate,
  isVocativeAddress,
  buildVoiceTurnContext,
} from '../../src/services/voice-gate';
import { VoiceGateTelemetry } from '../../src/services/voice-gate-telemetry';
import type { GateDialogueState } from '../../src/services/voice-gate';
import type { IStreamingTranscriptionProvider, StreamingTranscriptionCallbacks } from '../../src/services/transcription/IStreamingTranscriptionProvider';
import type { ITtsProvider, TtsStreamCallbacks } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Mock providers (same shapes as voice-loop.test.ts)
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
  receive = (payload: object) => {
    for (const h of this.handlers['message'] ?? []) h(Buffer.from(JSON.stringify(payload)));
  };
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

class MockStt implements IStreamingTranscriptionProvider {
  callbacks: StreamingTranscriptionCallbacks | null = null;
  async connect(callbacks: StreamingTranscriptionCallbacks) { this.callbacks = callbacks; }
  sendAudio() {}
  close() {}
  isOpen() { return true; }
  interim(text: string) { this.callbacks?.onInterim(text); }
  final(text: string) { this.callbacks?.onFinal(text); }
  speechStart() { this.callbacks?.onSpeechStart?.(); }
}

class MockTts implements ITtsProvider {
  callbacks: TtsStreamCallbacks | null = null;
  speak(callbacks: TtsStreamCallbacks) { this.callbacks = callbacks; }
  feed() {}
  endOfText() {}
  cancel() {}
  isSpeaking() { return false; }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeLoop(opts: { voiceSessions?: Record<string, any> } = {}) {
  const channels: Record<string, any> = {
    ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  };
  const agents: Record<string, any> = {
    agent1: { agentId: 'agent1', name: 'Alice', workspaceId: 'ws1' },
  };
  const voiceSessionUpdates: any[] = [];
  const savedChannelMessages: any[] = [];
  const broadcasts: any[] = [];
  const agentTurns: any[] = [];

  const collection = (name: string) => {
    if (name === 'channels') {
      return {
        findOne: async (q: any) => channels[q.channelId] ?? null,
        find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      };
    }
    if (name === 'agents') return { findOne: async (q: any) => agents[q.agentId] ?? null };
    if (name === 'voice_sessions') {
      return {
        updateOne: async (filter: any, update: any) => {
          voiceSessionUpdates.push({ filter, update });
          return { matchedCount: 1, modifiedCount: 1 };
        },
        findOne: async (q: any) => (opts.voiceSessions ?? {})[`${q.channelId}:${q.agentId}`] ?? null,
      };
    }
    if (name === 'channel_messages') {
      return {
        insertOne: async (doc: any) => { savedChannelMessages.push(doc); },
        find: (_q: any, _o: any) => ({
          sort: () => ({ limit: () => ({ toArray: async () => [] }) }),
          toArray: async () => [],
        }),
      };
    }
    return { findOne: async () => null, find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
  };

  const channelManager = {
    getChannel: async (id: string) => channels[id] ?? null,
    createMessageId: () => `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async (msg: any) => { savedChannelMessages.push(msg); },
  };
  const pubSubService = {
    addListener() {}, removeListener() {},
    broadcastToTopic(topic: string, event: any) { broadcasts.push({ topic, event }); },
  };

  const stt = new MockStt();
  const tts = new MockTts();
  const loop = new VoiceLoop(
    { collection } as any,
    channelManager as any,
    {} as any,
    {
      processAgentResponse: async (channelId: string, agentId: string, text: string) => {
        agentTurns.push({ channelId, agentId, text });
      },
    } as any,
    { canAccess: async () => true } as any,
    null,
    { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) } as any,
    { sttFactory: () => stt, ttsFactory: () => tts },
  );
  loop.setPubSubService(pubSubService as any);
  return { loop, stt, tts, agentTurns, savedChannelMessages, broadcasts, voiceSessionUpdates };
}

async function flush() {
  await new Promise((r) => setTimeout(r, 5));
}

/** Open a session in a given mode and return the harness. */
async function sessionInMode(mode: 'conversation' | 'passive') {
  const harness = makeLoop({ voiceSessions: { 'ch_conv:agent1': { mode } } });
  const ws = new FakeWs();
  await harness.loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
  return { harness, ws };
}

const NO_DIALOGUE: GateDialogueState = { agentJustSpoke: false, interruptedAgentSpeech: false };

// ---------------------------------------------------------------------------
// LAYER 1 — vocative (REQ-7: all modes)
// ---------------------------------------------------------------------------

describe('F2a layer 1 — vocative (all modes)', () => {
  it('detects a direct invocation in conversation AND passive', () => {
    for (const mode of ['conversation', 'passive'] as const) {
      const d = evaluateInvocationGate('Alice, ¿tú cómo lo ves?', mode, 'Alice', NO_DIALOGUE);
      expect(d.activated).toBe(true);
      expect(d.layer).toBe('vocative');
      expect(d.score).toBe(1);
      expect(mode).toBeTruthy(); // modes iterated, not skipped
    }
  });

  it('leading vocative with safe discourse markers ("oye, Alice…", "bueno Alice…")', () => {
    expect(isVocativeAddress('oye Alice dime la verdad', 'Alice')).toBe(true);
    expect(isVocativeAddress('bueno, Alice, ¿qué hacemos?', 'Alice')).toBe(true);
    expect(isVocativeAddress('hey Alice resume el fichero', 'Alice')).toBe(true);
  });

  it('trailing vocative ("¿qué te parece, Alice?") — but a mention stays a mention', () => {
    expect(isVocativeAddress('¿qué te parece, Alice?', 'Alice')).toBe(true);
    expect(isVocativeAddress('se lo dije a Alice', 'Alice')).toBe(false);
    expect(isVocativeAddress('mi amiga Alice trabaja aquí', 'Alice')).toBe(false);
  });

  it('bare hail ("Alice" / "¿Alice?") counts as an invocation', () => {
    expect(isVocativeAddress('Alice', 'Alice')).toBe(true);
    expect(isVocativeAddress('¿Alice?', 'Alice')).toBe(true);
  });

  it('STT spelling variants of the wake word still open the gate (documented confusions)', () => {
    expect(isVocativeAddress('Alicia, ¿tú cómo lo ves?', 'Alice')).toBe(true);
    expect(isVocativeAddress('alise resume el fichero', 'Alice')).toBe(true);
  });

  it('third-person mentions never fire in ANY mode (REQ-7 MUST NOT)', () => {
    for (const mode of ['conversation', 'passive'] as const) {
      const d = evaluateInvocationGate('le dije a Alice que lo haría', mode, 'Alice', NO_DIALOGUE);
      expect(d.activated).toBe(false);
      expect(d.signals).toContain('about-agent');
    }
    // Even in conversation — the mention check runs BEFORE the context layer.
    const d = evaluateInvocationGate('Alice dice que no puede', 'conversation', 'Alice', NO_DIALOGUE);
    expect(d.activated).toBe(false);
  });

  it('"Alice, es que no entiendo" is still an invocation (discourse opener exception)', () => {
    expect(isVocativeAddress('Alice, es que no entiendo esto', 'Alice')).toBe(true);
  });

  it('integration: vocative opens the agent turn in passive (the ladder works end-to-end)', async () => {
    const { harness } = await sessionInMode('passive');
    harness.stt.final('Alice, ¿tú cómo lo ves?');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
    // The vocative turn carries the voice-session context note (layer 3 note
    // rides the first turn after connect — passive flavor).
    expect(harness.agentTurns[0].text).toContain('modo escucha');
  });
});

// ---------------------------------------------------------------------------
// LAYER 2 — removed with the `attention` mode (Pablo 2026-10-05, a527c2a9c)
// ---------------------------------------------------------------------------

describe('F2a — no layer 2 (attention mode removed): two modes only', () => {
  it('passive: nothing but the vocative opens — not even directed-sounding speech', () => {
    const dialogue = { agentJustSpoke: true, interruptedAgentSpeech: true };
    for (const text of ['¿y el pico de agosto?', 'espera, ¿tú qué crees que pasa?', 'dime la verdad ahora', 'que te parece el plan']) {
      const d = evaluateInvocationGate(text, 'passive', 'Alice', dialogue);
      expect(d.activated).toBe(false);
      expect(d.layer).toBeNull();
      expect(d.signals).toContain('passive');
    }
  });

  it('the gate never reports a classifier score (layer 2 is gone)', () => {
    const dialogue = { agentJustSpoke: true, interruptedAgentSpeech: false };
    for (const mode of ['conversation', 'passive'] as const) {
      for (const text of ['Alice, hola', 'le dije a Alice que sí', 'cualquier cosa']) {
        const d = evaluateInvocationGate(text, mode, 'Alice', dialogue);
        expect(d.classifierScore).toBeNull();
        expect(d.layer).not.toBe('target');
      }
    }
  });

  it('integration (passive): non-vocative speech → persisted as overheard, no turn', async () => {
    const { harness, ws } = await sessionInMode('passive');

    harness.stt.final('hablando con mi jefe sobre el presupuesto');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);
    expect(harness.savedChannelMessages[0].source).toBe('voice');
    const overheardFrame = ws.frames().find((f) => f.type === 'transcript' && f.overheard);
    expect(overheardFrame.text).toBe('hablando con mi jefe sobre el presupuesto');

    // Even right after the agent spoke, a follow-up without the vocative stays
    // overheard — there is no dialogue-state boost in passive.
    const conn = (harness.loop as any).connections.values().next().value;
    conn.gateDialogue.agentJustSpoke = true;
    harness.stt.final('¿y el pico de agosto?');
    await flush();
    expect(harness.agentTurns.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LAYER 3 — dialogue context (REQ-7: conversation)
// ---------------------------------------------------------------------------

describe('available (Disponible) — PoC 2026-10-31: the vocative is the only door, nothing is kept', () => {
  it('non-vocative → not activated, signalled as available', () => {
    const d = evaluateInvocationGate('estamos viendo el informe de agosto', 'available', 'Alice', NO_DIALOGUE);
    expect(d.activated).toBe(false);
    expect(d.signals).toContain('available');
  });
  it('vocative → activated (layer 1)', () => {
    const d = evaluateInvocationGate('Alice, ¿qué tengo hoy?', 'available', 'Alice', NO_DIALOGUE);
    expect(d.activated).toBe(true);
    expect(d.layer).toBe('vocative');
  });
  it('dialogue window open → activated without the name, like passive', () => {
    const d = evaluateInvocationGate('¿y mañana?', 'available', 'Alice', { ...NO_DIALOGUE, dialogueWindowUntil: 10_000 }, 5_000);
    expect(d.activated).toBe(true);
    expect(d.signals).toEqual(['available', 'dialogue-window']);
  });
});

describe('F2a layer 3 — dialogue context (conversation)', () => {
  it('everything is a turn — even filler and third-party-ish phrasing', () => {
    for (const text of ['mmm…', 'bueno, no sé', '¿y el pico de agosto?', 'esto habría que meterlo en el board']) {
      const d = evaluateInvocationGate(text, 'conversation', 'Alice', NO_DIALOGUE);
      expect(d.activated).toBe(true);
      expect(d.layer).toBe('context');
    }
    // …EXCEPT a third-person mention of the agent (checked before layer 3).
    const mention = evaluateInvocationGate('le dije a Alice que vendría', 'conversation', 'Alice', NO_DIALOGUE);
    expect(mention.activated).toBe(false);
  });

  it('the voice-session context note rides the FIRST turn and is consumed once', async () => {
    const { harness } = await sessionInMode('conversation');
    harness.stt.final('hola');
    await flush();
    expect(harness.agentTurns[0].text).toContain('modo conversación');
    harness.stt.final('segunda cosa');
    await flush();
    expect(harness.agentTurns[1].text).toBe('segunda cosa');
  });

  it('a mode change re-arms the context note with the new mode', async () => {
    const { harness, ws } = await sessionInMode('conversation');
    ws.receive({ type: 'set_mode', mode: 'passive' });
    // The next (vocative) turn carries the passive-flavored note.
    harness.stt.final('Alice, ¿estás ahí?');
    await flush();
    expect(harness.agentTurns[0].text).toContain('modo escucha');
  });

  it('buildVoiceTurnContext covers both modes with spoken-response guidance', () => {
    for (const mode of ['conversation', 'passive'] as const) {
      const note = buildVoiceTurnContext(mode);
      expect(note).toContain('Sesión de voz activa');
      expect(note).toContain(mode === 'passive' ? 'modo escucha' : 'modo conversación');
      expect(note.toLowerCase()).toContain('hablada');
    }
  });
});

// ---------------------------------------------------------------------------
// OVERHEARD PERSISTENCE (REQ-9 — nothing is lost)
// ---------------------------------------------------------------------------

describe('F2a overheard persistence (REQ-9)', () => {
  it('non-activated utterances persist once with overheard:true + channel broadcast', async () => {
    const { harness } = await sessionInMode('passive');
    harness.stt.final('pensamiento en voz alta sobre el informe');
    await flush();
    expect(harness.savedChannelMessages.length).toBe(1);
    expect(harness.savedChannelMessages[0].overheard).toBe(true);
    expect(harness.savedChannelMessages[0].role).toBe('user');
    expect(harness.broadcasts.some((b) => b.topic === 'channel:ch_conv')).toBe(true);
    expect(harness.agentTurns.length).toBe(0);
  });

  it('activated utterances persist WITHOUT the overheard flag', async () => {
    const { harness } = await sessionInMode('passive');
    harness.stt.final('Alice, resume el fichero');
    await flush();
    expect(harness.savedChannelMessages[0].overheard).toBeUndefined();
    expect(harness.agentTurns.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TELEMETRY (REQ-11 / UC-12)
// ---------------------------------------------------------------------------

describe('F2a gate telemetry (REQ-11/UC-12)', () => {
  it('every decision is logged with mode, layer, score, activated', async () => {
    const { harness } = await sessionInMode('passive');
    harness.stt.final('hablando con otro');       // overheard
    await flush();
    harness.stt.final('Alice, dime algo');        // vocative → activated
    await flush();

    const log = harness.loop.getGateDecisionLog();
    expect(log.length).toBe(2);
    expect(log[0]).toMatchObject({ mode: 'passive', activated: false, layer: null });
    expect(log[1]).toMatchObject({ mode: 'passive', activated: true, layer: 'vocative', score: 1 });
    expect(log[1].signals).toContain('vocative');
  });

  it('counters aggregate per mode and per layer', async () => {
    const { harness, ws } = await sessionInMode('conversation');
    harness.stt.final('una');                       // context layer
    await flush();
    harness.stt.final('dos');                       // context layer
    await flush();
    ws.receive({ type: 'set_mode', mode: 'passive' });
    harness.stt.final('ruido');                     // overheard in passive
    await flush();
    harness.stt.final('Alice, hola');               // vocative in passive
    await flush();

    const stats = harness.loop.getGateTelemetry();
    expect(stats.total).toBe(4);
    expect(stats.byMode.conversation?.activated).toBe(2);
    expect(stats.byMode.passive?.evaluated).toBe(2);
    expect(stats.byMode.passive?.overheard).toBe(1);
    expect(stats.activationsByLayer.context).toBe(2);
    expect(stats.activationsByLayer.vocative).toBe(1);
    // The health proxies: no missed vocatives, no non-vocative passive activations.
    expect(stats.missedVocatives).toBe(0);
    expect(stats.passiveNonVocativeActivations).toBe(0);
  });

  it('the pure telemetry class: false-negative proxy + null classifier mean', () => {
    const t = new VoiceGateTelemetry(() => 1000);
    // A missed vocative (should never happen — surfaces as the UC-12 B proxy).
    t.record('ch', 'ag', { activated: false, layer: null, score: 0, classifierScore: null, signals: ['vocative'], reason: 'x' }, 'passive');
    // A vocative that opened.
    t.record('ch', 'ag', { activated: true, layer: 'vocative', score: 1, classifierScore: null, signals: ['vocative'], reason: 'x' }, 'passive');

    const stats = t.stats();
    expect(stats.missedVocatives).toBe(1);
    expect(stats.byMode.passive?.evaluated).toBe(2);
    expect(stats.byMode.passive?.activated).toBe(1);
    expect(stats.byMode.passive?.overheard).toBe(1);
    // Layer 2 is gone: no classifier samples → the mean stays null (kept in
    // the shape for telemetry stability), and nothing opens via 'target'.
    expect(stats.byMode.passive?.meanTargetScore).toBeNull();
    expect(stats.activationsByLayer.target).toBe(0);
    expect(stats.activationsByLayer.vocative).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EDGE CASES (§edge cases + "invocación con ruido")
// ---------------------------------------------------------------------------

describe('F2a edge cases', () => {
  it('invocation with STT noise: garbled wake word variants still open', () => {
    // STT noise around the name — the leading-position scan finds it.
    expect(isVocativeAddress('eh, Alice, ¿me oyes?', 'Alice')).toBe(true);
    expect(isVocativeAddress('mm Alice resume', 'Alice')).toBe(true);
  });

  it('short/garbage utterances do not crash the gate and stay overheard', () => {
    for (const text of ['', '   ', '…', 'a', '¿?']) {
      const d = evaluateInvocationGate(text, 'passive', 'Alice', NO_DIALOGUE);
      expect(d.activated).toBe(false);
    }
  });

  it('diacritics are stripped for matching (STT drops accents constantly)', () => {
    expect(isVocativeAddress('¿qué te parece, Alícia?', 'Alice')).toBe(true);
    expect(isVocativeAddress('Alíce, ¿me oyes?', 'Alice')).toBe(true);
  });

  it('mode switch mid-session: conversation → passive stops non-vocative turns', async () => {
    const { harness, ws } = await sessionInMode('conversation');
    ws.receive({ type: 'set_mode', mode: 'passive' });
    harness.stt.final('dime la verdad'); // would be a turn in conversation
    await flush();
    expect(harness.agentTurns.length).toBe(0); // passive: only the vocative opens
  });

  it('set_mode rejects the removed attention mode (two modes only)', async () => {
    const { harness, ws } = await sessionInMode('conversation');
    ws.receive({ type: 'set_mode', mode: 'attention' });
    const err = ws.frames().find((f) => f.type === 'error');
    expect(err?.code).toBe('bad_request');
    expect(ws.frames().some((f) => f.type === 'mode_changed')).toBe(false);
    // Still in conversation: a plain utterance is a turn.
    harness.stt.final('hola');
    await flush();
    expect(harness.agentTurns.length).toBe(1);
  });

  it('dialogue state does not leak across a mode change', async () => {
    const { harness, ws } = await sessionInMode('conversation');
    const conn = (harness.loop as any).connections.values().next().value;
    conn.gateDialogue.agentJustSpoke = true;
    conn.gateDialogue.interruptedAgentSpeech = true;
    ws.receive({ type: 'set_mode', mode: 'conversation' }); // any set_mode resets state
    expect(conn.gateDialogue.agentJustSpoke).toBe(false);
    expect(conn.gateDialogue.interruptedAgentSpeech).toBe(false);
  });

});

describe('passive dialogue window (Pablo, PoC 2026-10-31)', () => {
  it('an open window lets a nameless utterance through in passive; a closed one does not', () => {
    const now = 1_000_000;
    const open = evaluateInvocationGate('¿y mañana qué tengo?', 'passive', 'Iria', { agentJustSpoke: true, interruptedAgentSpeech: false, dialogueWindowUntil: now + 5000 }, now);
    expect(open.activated).toBe(true);
    expect(open.signals).toContain('dialogue-window');
    const expired = evaluateInvocationGate('¿y mañana qué tengo?', 'passive', 'Iria', { agentJustSpoke: true, interruptedAgentSpeech: false, dialogueWindowUntil: now - 1 }, now);
    expect(expired.activated).toBe(false);
    const none = evaluateInvocationGate('¿y mañana qué tengo?', 'passive', 'Iria', { agentJustSpoke: true, interruptedAgentSpeech: false }, now);
    expect(none.activated).toBe(false);
  });
});
