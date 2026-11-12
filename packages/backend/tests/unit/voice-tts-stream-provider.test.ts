/**
 * ElevenLabsStreamTtsProvider — F5d unit tests (spec v1.1.0 REQ-3).
 *
 * The stream-input WS provider against a FAKE WebSocket (wsImpl injection —
 * no real network, no real keys):
 *
 *  1. Protocol: speak() → bos with chunk_length_schedule [50,100,180,250];
 *     feed() pushes deltas word-by-word exactly as received (no sentence
 *     boundary wait); endOfText() → final empty message (flush).
 *  2. Deltas fed while the WS is still connecting are buffered and pushed
 *     in order on open.
 *  3. Audio frames → onStart once + onChunk in order (~3KB slices);
 *     isFinal → onEnd.
 *  4. Barge-in (REQ-4): cancel() closes the WS immediately — no callback
 *     fires after cancel() returns (no orphan audio).
 *  5. Fallback: WS connect error or mid-turn death → the turn degrades to
 *     the sentence provider (HTTP per sentence) with the whole fed text
 *     replayed — no spoken word lost; endOfText rides through.
 *  6. After 2 WS failures the provider goes straight to the fallback
 *     (no third WS attempt).
 *  7. No API key → onError (same contract as the sentence provider).
 */

import { describe, expect, it } from 'bun:test';
import {
  ElevenLabsStreamTtsProvider,
} from '../../src/services/tts/ElevenLabsStreamTtsProvider';
import type { TtsStreamCallbacks } from '../../src/services/tts/ITtsProvider';

// ---------------------------------------------------------------------------
// Fake WebSocket (ws-package-compatible subset)
// ---------------------------------------------------------------------------

const OPEN = 1;

class FakeWs {
  static instances: FakeWs[] = [];
  static connectFailures = 0; // how many times 'error' fires before open
  static midTurnDeath = false; // close the WS after N sends

  sent: string[] = [];
  closed = false;
  readyState = OPEN;
  handlers: Record<string, ((...args: any[]) => void)[]> = {};
  /** After how many sends the WS dies mid-turn (0 = never). */
  dieAfterSends = 0;

  constructor(public url: string, public opts?: any) {
    FakeWs.instances.push(this);
    this.dieAfterSends = FakeWs.midTurnDeath ? 1 : 0;
    // Async open (like a real WS) — or a connect error.
    queueMicrotask(() => {
      if (FakeWs.connectFailures > 0) {
        FakeWs.connectFailures -= 1;
        this.emit('error', new Error('connect refused'));
      } else {
        this.emit('open');
      }
    });
  }

  on(event: string, handler: (...args: any[]) => void) {
    (this.handlers[event] ??= []).push(handler);
    return this;
  }
  once(event: string, handler: (...args: any[]) => void) {
    const wrapped = (...args: any[]) => {
      this.removeListener(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }
  removeListener(event: string, handler: (...args: any[]) => void) {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== handler);
    return this;
  }
  removeAllListeners() {
    this.handlers = {};
    return this;
  }
  send(data: string) {
    this.sent.push(data);
    if (this.dieAfterSends > 0 && this.sent.length >= this.dieAfterSends) {
      this.dieAfterSends = 0;
      // Mid-turn death: the server vanishes after the first delta.
      queueMicrotask(() => this.emit('close'));
    }
  }
  close() { this.closed = true; }
  emit(event: string, ...args: any[]) {
    for (const h of [...(this.handlers[event] ?? [])]) h(...args);
  }
  frames() { return this.sent.map((s) => JSON.parse(s)); }
  /** Test helper: a server audio frame. */
  serverAudio(audio: string, isFinal = false) {
    this.emit('message', Buffer.from(JSON.stringify({ audio, isFinal })));
  }
}

function makeCallbacks() {
  const calls: string[] = [];
  const chunks: string[] = [];
  const cb: TtsStreamCallbacks = {
    onStart: () => calls.push('start'),
    onChunk: (b) => { chunks.push(b); calls.push('chunk'); },
    onEnd: () => calls.push('end'),
    onError: (e) => calls.push(`error:${e.message}`),
  };
  return { cb, calls, chunks };
}

/** Flush the microtask queue (fake WS opens/dies on microtasks). */
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 1));
}

function makeProvider(
  overrides: Partial<ConstructorParameters<typeof ElevenLabsStreamTtsProvider>[0]> = {},
  opts: { connectFailures?: number; midTurnDeath?: boolean } = {},
) {
  FakeWs.instances = [];
  FakeWs.connectFailures = opts.connectFailures ?? 0;
  FakeWs.midTurnDeath = opts.midTurnDeath ?? false;
  return new ElevenLabsStreamTtsProvider({
    apiKey: 'test-key',
    wsImpl: FakeWs as any,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Protocol — bos + word-by-word deltas + final empty flush
// ---------------------------------------------------------------------------

describe('ElevenLabsStreamTtsProvider — protocol (F5d)', () => {
  it('speak() sends bos with the chunk_length_schedule', async () => {
    const p = makeProvider();
    const { cb } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    expect(ws.url).toContain('stream-input');
    expect(ws.url).toContain('model_id=eleven_flash_v2_5');
    expect(ws.opts.headers['xi-api-key']).toBe('test-key');
    const bos = ws.frames()[0];
    expect(bos.generation_config.chunk_length_schedule).toEqual([50, 100, 180, 250]);
    expect(bos.model_id).toBe('eleven_flash_v2_5');
    expect(bos.output_format).toBe('mp3_44100_128');
  });

  it('feed() pushes deltas word-by-word — no sentence boundary wait', async () => {
    const p = makeProvider();
    const { cb } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    const bosCount = ws.sent.length;
    // Word-by-word deltas, exactly as an LLM emits them — none of these
    // words completes a sentence, and ALL of them must reach the WS.
    for (const word of ['Hola ', 'qué ', 'tal ', 'estás ']) p.feed(word);
    const deltas = ws.frames().slice(bosCount);
    expect(deltas).toEqual([{ text: 'Hola ' }, { text: 'qué ' }, { text: 'tal ' }, { text: 'estás ' }]);
  });

  it('endOfText() sends the final empty message (flush)', async () => {
    const p = makeProvider();
    const { cb } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    p.feed('Hola, ¿qué tal?');
    p.endOfText();
    const last = ws.frames()[ws.frames().length - 1];
    expect(last).toEqual({ text: '' });
  });

  it('deltas fed while connecting are buffered and pushed in order on open', async () => {
    const p = makeProvider();
    const { cb } = makeCallbacks();
    p.speak(cb);
    // Feed BEFORE the WS opens (the LLM is faster than the WS handshake).
    p.feed('Hola ');
    p.feed('qué ');
    await flush();
    const ws = FakeWs.instances[0];
    const frames = ws.frames();
    // bos, then the buffered deltas in feed order, no loss, no reorder.
    expect(frames[1]).toEqual({ text: 'Hola ' });
    expect(frames[2]).toEqual({ text: 'qué ' });
  });

  it('endOfText before the WS opens rides on open (short ack turn)', async () => {
    const p = makeProvider();
    const { cb } = makeCallbacks();
    p.speak(cb);
    p.feed('Vale.');
    p.endOfText();
    await flush();
    const ws = FakeWs.instances[0];
    const frames = ws.frames();
    expect(frames[0].generation_config).toBeDefined(); // bos
    expect(frames[1]).toEqual({ text: 'Vale.' });
    expect(frames[frames.length - 1]).toEqual({ text: '' }); // flush
  });
});

// ---------------------------------------------------------------------------
// 2. Audio delivery — onStart once, ordered chunks, isFinal → onEnd
// ---------------------------------------------------------------------------

describe('ElevenLabsStreamTtsProvider — audio frames', () => {
  it('first audio → onStart once; chunks in order; isFinal → onEnd', async () => {
    const p = makeProvider();
    const { cb, calls, chunks } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    p.feed('Hola.');
    ws.serverAudio('AAAA');
    ws.serverAudio('BBBB');
    expect(calls).toEqual(['start', 'chunk', 'chunk']);
    expect(chunks).toEqual(['AAAA', 'BBBB']);
    ws.serverAudio('CCCC', true);
    expect(calls).toEqual(['start', 'chunk', 'chunk', 'chunk', 'end']);
    expect(ws.closed).toBe(true); // the turn drained — the WS closes
    expect(p.isSpeaking()).toBe(false);
  });

  it('large audio frames are sliced into ~3KB base64 chunks', async () => {
    const p = makeProvider();
    const { cb, chunks } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    const big = 'A'.repeat(3 * 1024 * 2 + 100); // ~2.03 frames
    ws.serverAudio(big);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(3 * 1024);
    expect(chunks[2].length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 3. Barge-in (REQ-4) — cancel cuts immediately, no orphan audio
// ---------------------------------------------------------------------------

describe('ElevenLabsStreamTtsProvider — cancel (REQ-4)', () => {
  it('cancel() closes the WS and no callback fires after it returns', async () => {
    const p = makeProvider();
    const { cb, calls } = makeCallbacks();
    p.speak(cb);
    await flush();
    const ws = FakeWs.instances[0];
    p.feed('Hola, esto es una respuesta larga.');
    ws.serverAudio('AAAA');
    expect(calls).toContain('start');
    p.cancel();
    expect(ws.closed).toBe(true);
    const callsAfterCancel = [...calls];
    // Late server audio after the barge-in — must be dropped silently.
    ws.serverAudio('BBBB', true);
    expect(calls).toEqual(callsAfterCancel);
    expect(p.isSpeaking()).toBe(false);
  });

  it('cancel() before the WS opens kills the pending turn', async () => {
    const p = makeProvider();
    const { cb, calls } = makeCallbacks();
    p.speak(cb);
    p.feed('Hola ');
    p.cancel();
    await flush();
    const ws = FakeWs.instances[0];
    expect(ws.closed).toBe(true);
    // No bos, no deltas, nothing — the turn never started.
    expect(ws.sent).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback — WS failure degrades to the sentence provider
// ---------------------------------------------------------------------------

/** Fake fetch for the fallback sentence provider: returns fixed audio. */
function fakeFetchWithAudio(audio = 'FALLBACK-AUDIO') {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => Buffer.from(audio),
      text: async () => '',
    } as any;
  }) as any;
  return { impl, calls };
}

describe('ElevenLabsStreamTtsProvider — fallback to sentences', () => {
  it('WS connect error degrades the turn to the sentence provider, replaying all fed text', async () => {
    const fetches = fakeFetchWithAudio();
    const p = makeProvider({ fetchImpl: fetches.impl }, { connectFailures: 1 });
    const { cb, calls, chunks } = makeCallbacks();
    p.speak(cb);
    p.feed('Primera frase. '); // fed while connecting
    p.feed('Segunda frase.');
    p.endOfText();
    await flush();
    // The whole turn's text reached the HTTP fallback — nothing lost.
    expect(fetches.calls.length).toBe(2);
    expect(fetches.calls[0].body.text).toBe('Primera frase.');
    expect(fetches.calls[1].body.text).toBe('Segunda frase.');
    // The sentence provider delivers base64 chunks (the ITtsProvider contract).
    const expectedAudio = Buffer.from('FALLBACK-AUDIO').toString('base64');
    expect(chunks).toEqual([expectedAudio, expectedAudio]);
    expect(calls).toContain('end');
  });

  it('WS death mid-turn degrades and replays the text fed so far', async () => {
    const fetches = fakeFetchWithAudio();
    const p = makeProvider({ fetchImpl: fetches.impl }, { midTurnDeath: true });
    const { cb, calls } = makeCallbacks();
    p.speak(cb);
    await flush(); // open + bos sent → WS dies
    p.feed('Frase completa. '); // goes nowhere (WS dead) — buffered in fedText
    p.feed('Otra frase.');
    p.endOfText();
    await flush();
    expect(fetches.calls.length).toBe(2);
    expect(fetches.calls[0].body.text).toBe('Frase completa.');
    expect(fetches.calls[1].body.text).toBe('Otra frase.');
    expect(calls).toContain('end');
  });

  it('after 2 WS failures the provider goes straight to the fallback', async () => {
    const fetches = fakeFetchWithAudio();
    // Turn 1: WS fails once (failure #1) → fallback.
    const p = makeProvider({ fetchImpl: fetches.impl }, { connectFailures: 1 });
    const { cb: cb1 } = makeCallbacks();
    p.speak(cb1);
    p.feed('Uno.');
    p.endOfText();
    await flush();
    // Turn 2: WS fails again (failure #2) → fallback.
    FakeWs.connectFailures = 1;
    const { cb: cb2 } = makeCallbacks();
    p.speak(cb2);
    p.feed('Dos.');
    p.endOfText();
    await flush();
    const wsAttempts = FakeWs.instances.length;
    // Turn 3: no third WS attempt — straight to the fallback.
    const { cb: cb3, calls: calls3 } = makeCallbacks();
    p.speak(cb3);
    p.feed('Tres.');
    p.endOfText();
    await flush();
    expect(FakeWs.instances.length).toBe(wsAttempts); // no new WS
    expect(fetches.calls.length).toBe(3);
    expect(fetches.calls[2].body.text).toBe('Tres.');
    expect(calls3).toContain('end');
  });

  it('no API key → onError (sentence-provider contract)', async () => {
    const p = new ElevenLabsStreamTtsProvider({ wsImpl: FakeWs as any });
    const { cb, calls } = makeCallbacks();
    p.speak(cb);
    expect(calls[0]).toMatch(/^error:/);
    expect(calls[0]).toContain('No ElevenLabs API key');
  });
});
