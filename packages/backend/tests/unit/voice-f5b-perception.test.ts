/**
 * F5b — perception tuning tests: endpointing flag + filler phrase.
 *
 * Covers the three acceptance surfaces of the task:
 *
 *  1. ENDPOINTING: the `voice.endpointing-ms` flag (default 200, was 300
 *     hardcoded) reaches the STT connect config; resolution failures and
 *     absurd values degrade safely; the provider-level tunable chain stays
 *     intact (per-connect config > provider config > 300).
 *  2. FILLER: the `voice.filler` flag (default off) gates the whole
 *     mechanism; the filler only plays when the first LLM chunk is later
 *     than the grace window (~400ms); a chunk inside the window disarms it;
 *     the filler is delivered as ordinary tts_chunk frames (interruptible
 *     by barge-in client-side) and never opens the ElevenLabs stream.
 *  3. TELEMETRY: the latency budget splits the end-to-end histogram by
 *     whether the filler played (statsByFiller) — the with-vs-without
 *     comparison surface.
 *
 * Strategy: same harness as voice-tts-flag-wiring.test.ts (FakeWs, stub
 * deps, connections map via (loop as any)), with a controllable fake
 * clock for the grace-window timing and a stub FeatureFlagService whose
 * resolve() the tests drive per key.
 */

import { describe, expect, it } from 'bun:test';
import { VoiceLoop } from '../../src/handlers/voice-loop';
import { VoiceLoopLatencyBudget, TurnLatencyTrace } from '../../src/services/voice-loop-latency';
import { setFillerForTests, resetFillerCacheForTests } from '../../src/services/voice-filler';
import type { IStreamingTranscriptionProvider, StreamingTranscriptionCallbacks, StreamingTranscriptionConfig } from '../../src/services/transcription/IStreamingTranscriptionProvider';
import type { ITtsProvider } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Stubs (same shapes as voice-tts-flag-wiring.test.ts)
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
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}

/** STT stub that records the connect config (the endpointing assertion). */
class RecordingStt implements IStreamingTranscriptionProvider {
  callbacks: StreamingTranscriptionCallbacks | null = null;
  lastConfig: StreamingTranscriptionConfig | undefined;
  async connect(callbacks: StreamingTranscriptionCallbacks, config?: StreamingTranscriptionConfig) {
    this.callbacks = callbacks;
    this.lastConfig = config;
  }
  sendAudio() {}
  close() {}
}

class MarkerTts implements ITtsProvider {
  speakCalls = 0;
  speak() { this.speakCalls += 1; }
  feed() {}
  endOfText() {}
  cancel() {}
  isSpeaking() { return false; }
}

/** Flag service whose resolve() the tests drive per key. */
class MapFlagService {
  constructor(public values: Record<string, any>) {}
  async resolve(key: string): Promise<any> { return this.values[key]; }
}

/** Flag service that throws for the perception keys (degradation path). */
class ThrowingPerceptionFlagService {
  async resolve(key: string): Promise<any> {
    if (key === 'voice.endpointing-ms' || key === 'voice.filler') {
      throw new Error('flag backend down');
    }
    return key === 'voice.tts' ? 'sentences' : undefined;
  }
}

function makeDb(channels: Record<string, any>) {
  const collection = (name: string) => ({
    findOne: async (filter: any) => {
      if (name === 'channels') return channels[filter.channelId] ?? null;
      if (name === 'agents') return { agentId: filter.agentId, name: 'Agent', workspaceId: 'ws1' };
      if (name === 'voice_sessions') return null;
      return null;
    },
    updateOne: async () => {},
  });
  return { collection: (name: string) => collection(name) } as any;
}

function makeLoop(opts: {
  channels?: Record<string, any>;
  flagService?: any;
} = {}) {
  const channels = opts.channels ?? {
    ch_conv: { channelId: 'ch_conv', userId: 'u1', workspaceId: 'ws1', metadata: { name: 'Conv' } },
  };
  const db = makeDb(channels);
  const channelManager = {
    getChannel: async (id: string) => channels[id] ?? null,
    createMessageId: () => `msg_${Math.random().toString(36).slice(2, 8)}`,
    saveMessage: async () => {},
  };
  const pubSubService = { addListener() {}, removeListener() {}, broadcastToTopic() {} };
  const authService = { validateSession: async () => ({ success: true, user: { userId: 'u1' } }) };
  const workspaceService = { canAccess: async () => true };
  const messageHandler = { processAgentResponse: async () => {} };
  const stt = new RecordingStt();
  const tts = new MarkerTts();

  const loop = new VoiceLoop(
    db,
    channelManager as any,
    {} as any,
    messageHandler as any,
    workspaceService as any,
    opts.flagService ?? null,
    authService as any,
    { sttFactory: () => stt, ttsFactory: () => tts },
  );
  loop.setPubSubService(pubSubService as any);
  return { loop, stt, tts };
}

/** Connect a session and return the connection + ws. */
async function connectSession(loop: VoiceLoop) {
  const ws = new FakeWs();
  await loop.handleConnection(ws as any, 's1', 'agent1', undefined, 'ch_conv');
  const connection = (loop as any).connections.values().next().value;
  return { ws, connection };
}

// ---------------------------------------------------------------------------
// 1. ENDPOINTING (voice.endpointing-ms)
// ---------------------------------------------------------------------------

describe('F5b — endpointing flag (voice.endpointing-ms)', () => {
  it('default (no flag service) — the STT connect config carries 200ms (was 300)', async () => {
    const { loop, stt } = makeLoop();
    await connectSession(loop);
    expect(stt.lastConfig?.endpointingMs).toBe(200);
  });

  it('flag resolved 250 — the connect config carries 250 (the documented fallback value)', async () => {
    const { loop, stt } = makeLoop({ flagService: new MapFlagService({ 'voice.endpointing-ms': 250 }) });
    await connectSession(loop);
    expect(stt.lastConfig?.endpointingMs).toBe(250);
  });

  it('flag resolution throws — degrades to 200 (the session never breaks)', async () => {
    const { loop, stt } = makeLoop({ flagService: new ThrowingPerceptionFlagService() });
    await connectSession(loop);
    expect(stt.lastConfig?.endpointingMs).toBe(200);
  });

  it('absurd flag values are clamped to the sane range (100–1000)', async () => {
    const { loop, stt } = makeLoop({ flagService: new MapFlagService({ 'voice.endpointing-ms': 5 }) });
    await connectSession(loop);
    expect(stt.lastConfig?.endpointingMs).toBe(100);

    const { loop: loop2, stt: stt2 } = makeLoop({ flagService: new MapFlagService({ 'voice.endpointing-ms': 99999 }) });
    await connectSession(loop2);
    expect(stt2.lastConfig?.endpointingMs).toBe(1000);
  });

  it('the provider tunable chain stays intact: per-connect config > provider config > 300', async () => {
    // The Deepgram provider's own chain (verified by reading the provider):
    // config?.endpointingMs ?? this.config.endpointingMs ?? 300. The loop now
    // feeds the per-connect layer with the flag value; a provider built with
    // an explicit endpointingMs still wins over its own default — the loop
    // cannot break that because it never touches the provider's config.
    // Here: the loop's value flows through the connect call (the first
    // link of the chain).
    const { loop, stt } = makeLoop({ flagService: new MapFlagService({ 'voice.endpointing-ms': 300 }) });
    await connectSession(loop);
    expect(stt.lastConfig?.endpointingMs).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 2. FILLER (voice.filler)
// ---------------------------------------------------------------------------

describe('F5b — filler phrase (voice.filler)', () => {
  it('default off — no filler timer is ever armed', async () => {
    const { loop } = makeLoop();
    const { connection } = await connectSession(loop);
    expect(connection.fillerEnabled).toBe(false);
    // An activated turn does not arm anything.
    await (loop as any).handleFinalTranscript(
      (loop as any).connections.keys().next().value, 'hola, ¿qué tal?',
    );
    expect(connection.fillerTimer).toBe(null);
  });

  it('flag on, first chunk inside the grace window — NOTHING plays (the filler only covers the real gap)', async () => {
    setFillerForTests('QUJD'); // "ABC" base64 — a fake filler payload
    const { loop, tts } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { ws, connection } = await connectSession(loop);
    expect(connection.fillerEnabled).toBe(true);

    const connectionId = (loop as any).connections.keys().next().value;
    await (loop as any).handleFinalTranscript(connectionId, 'hola, ¿qué tal?');
    expect(connection.fillerTimer).not.toBe(null); // armed

    // The first LLM chunk arrives INSIDE the window (immediately) — the
    // listener path disarms the timer.
    const listener = connection.listener;
    listener(JSON.stringify({ type: 'message_chunk', chunkType: 'text_chunk', text: 'Hola', messageId: 'm1' }));
    expect(connection.fillerTimer).toBe(null); // disarmed

    // No filler frames were sent — the client heard nothing but the real answer.
    const fillerFrames = ws.frames().filter((f) => f.type === 'tts_chunk');
    expect(fillerFrames.length).toBe(0);
    // The real TTS stream opened instead (the normal path, untouched).
    expect(tts.speakCalls).toBe(1);
    resetFillerCacheForTests();
  });

  it('flag on, chunk later than the grace window — the filler plays as tts_chunk frames, bracketed by speaking marks', async () => {
    setFillerForTests('QUJDRA=='); // "ABCD" — 4 frames worth when chunked small
    const { loop, tts } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { ws, connection } = await connectSession(loop);
    const connectionId = (loop as any).connections.keys().next().value;

    await (loop as any).handleFinalTranscript(connectionId, 'hola, ¿qué tal?');

    // Fire the grace timer synchronously (the real one waits 400ms).
    (loop as any).playFiller(connectionId);

    const frames = ws.frames();
    const started = frames.filter((f) => f.type === 'speaking_started');
    const chunks = frames.filter((f) => f.type === 'tts_chunk');
    const ended = frames.filter((f) => f.type === 'speaking_ended');
    expect(started.length).toBe(1);
    expect(ended.length).toBe(1);
    expect(chunks.length).toBeGreaterThan(0);
    // The frames carry the fake filler payload, reassembled.
    const reassembled = chunks.map((f) => f.audio_base_64).join('');
    expect(reassembled).toBe('QUJDRA==');
    // The filler NEVER opens the ElevenLabs stream — no synthesis call.
    expect(tts.speakCalls).toBe(0);
    // The trace is stamped: the e2e split can separate this turn.
    expect(connection.latencyTrace.fillerPlayed).toBe(true);
    // PoC round 1 (2026-10-31): the filler is NOT first audio — counting it
    // faked the e2e histogram (p50 480 ms). firstAudioAt waits for real TTS.
    expect(connection.latencyTrace.firstAudioAt).toBe(null);
    resetFillerCacheForTests();
  });

  it('a chunk arriving after the filler played opens the real TTS stream normally (never two audios)', async () => {
    setFillerForTests('QUJD');
    const { loop, tts } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { connection } = await connectSession(loop);
    const connectionId = (loop as any).connections.keys().next().value;

    await (loop as any).handleFinalTranscript(connectionId, 'hola');
    (loop as any).playFiller(connectionId); // the gap was real

    // The first real chunk arrives after the filler burst (the burst is
    // synchronous — fillerPlaying is false again by now).
    const listener = connection.listener;
    listener(JSON.stringify({ type: 'message_chunk', chunkType: 'text_chunk', text: 'Hola', messageId: 'm1' }));
    expect(tts.speakCalls).toBe(1); // the real stream opened
    expect(connection.ttsActive).toBe(true);
    resetFillerCacheForTests();
  });

  it('a barge-in kills the pending filler timer — no filler over the user', async () => {
    setFillerForTests('QUJD');
    const { loop } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { connection } = await connectSession(loop);
    const connectionId = (loop as any).connections.keys().next().value;

    await (loop as any).handleFinalTranscript(connectionId, 'hola');
    expect(connection.fillerTimer).not.toBe(null);

    (loop as any).handleBargeIn(connectionId, 0, 'client');
    expect(connection.fillerTimer).toBe(null);
    expect(connection.turnFrozen).toBe(true);

    // The grace timer firing now does nothing — the turn is frozen.
    (loop as any).playFiller(connectionId);
    const ws = (loop as any).connections.get(connectionId).clientWs;
    const fillerFrames = ws.frames().filter((f) => f.type === 'tts_chunk');
    expect(fillerFrames.length).toBe(0);
    resetFillerCacheForTests();
  });

  it('missing asset — silent degradation, the session proceeds (no crash, no frames)', async () => {
    setFillerForTests(null); // asset unavailable
    const { loop } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { ws, connection } = await connectSession(loop);
    const connectionId = (loop as any).connections.keys().next().value;

    await (loop as any).handleFinalTranscript(connectionId, 'hola');
    (loop as any).playFiller(connectionId); // fires with no asset

    const fillerFrames = ws.frames().filter((f) => f.type === 'tts_chunk');
    expect(fillerFrames.length).toBe(0);
    expect(connection.fillerPlaying).toBe(false);
    resetFillerCacheForTests();
  });

  it('cleanup clears a pending filler timer (no filler after the session dies)', async () => {
    setFillerForTests('QUJD');
    const { loop } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    const { connection } = await connectSession(loop);
    const connectionId = (loop as any).connections.keys().next().value;

    await (loop as any).handleFinalTranscript(connectionId, 'hola');
    expect(connection.fillerTimer).not.toBe(null);

    (loop as any).cleanup(connectionId);
    expect(connection.fillerTimer).toBe(null);
    resetFillerCacheForTests();
  });
});

// ---------------------------------------------------------------------------
// 3. TELEMETRY (statsByFiller — the with-vs-without e2e comparison)
// ---------------------------------------------------------------------------

describe('F5b — latency budget filler split (statsByFiller)', () => {
  it('filler vs no-filler turns land in separate histograms; the aggregate keeps both', () => {
    const clock = { t: 1000 };
    const mk = () => () => clock.t;
    const budget = new VoiceLoopLatencyBudget();

    // A filler turn: sttFinal at t, filler audio at +450 (the gap was real),
    // first text chunk later at +900 (the real answer followed the filler).
    const fillerTrace = new TurnLatencyTrace(mk());
    fillerTrace.markSttFinal();
    clock.t += 450;
    fillerTrace.markFirstAudio(); // the filler IS first audio
    clock.t += 450;
    fillerTrace.markFirstTextChunk();
    fillerTrace.fillerPlayed = true;
    budget.record(fillerTrace);

    // A no-filler turn: sttFinal at t, first chunk +250 (inside the grace
    // window — the filler never armed), first audio +650.
    const noFillerTrace = new TurnLatencyTrace(mk());
    noFillerTrace.markSttFinal();
    clock.t += 250;
    noFillerTrace.markFirstTextChunk();
    clock.t += 400;
    noFillerTrace.markFirstAudio();
    budget.record(noFillerTrace);

    const byFiller = budget.statsByFiller();
    expect(byFiller.filler.count).toBe(1);
    expect(byFiller.noFiller.count).toBe(1);
    // The MEAN is exact (percentiles are bucketed — see voice-fast-llm tests).
    expect(byFiller.filler.mean).toBe(450);
    expect(byFiller.noFiller.mean).toBe(650);

    // The aggregate endToEnd keeps BOTH samples (backward compatible).
    const aggregate = budget.stats('endToEnd');
    expect(aggregate.count).toBe(2);
  });

  it('default fillerPlayed=false — a trace that never played a filler lands in the no-filler histogram', () => {
    const budget = new VoiceLoopLatencyBudget();
    const trace = new TurnLatencyTrace();
    trace.markSttFinal();
    trace.markFirstTextChunk();
    trace.markFirstAudio();
    budget.record(trace); // no fillerPlayed assignment
    const byFiller = budget.statsByFiller();
    expect(byFiller.noFiller.count).toBe(1);
    expect(byFiller.filler.count).toBe(0);
  });

  it('the summary surface exposes the split (getVoiceHealthSummary.endToEndByFiller)', async () => {
    setFillerForTests('QUJD');
    const { loop } = makeLoop({ flagService: new MapFlagService({ 'voice.filler': true }) });
    await connectSession(loop);
    const summary = loop.getVoiceHealthSummary();
    expect(summary.endToEndByFiller).toBeDefined();
    expect(summary.endToEndByFiller.filler.count).toBe(0); // no turns yet
    expect(summary.endToEndByFiller.noFiller.count).toBe(0);
    resetFillerCacheForTests();
  });
});
