/**
 * DeepgramStreamingTranscriptionProvider — unit tests.
 *
 * The streaming STT provider against a FAKE WebSocket (wsImpl injection —
 * no real network, no real keys):
 *
 *  1. THE LONG-UTTERANCE BUG (the reason this suite exists): Deepgram closes
 *     STABLE windows (is_final=true, speech_final=false) while the user is
 *     still speaking, and every later Results message only carries the NEW
 *     window's transcript. Before the fix, a long continuous utterance lost
 *     everything but the last window — the interim line was overwritten with
 *     the latest fragment (the UI "disappears and is rewritten") and the
 *     final only contained the last phrase. Now the provider accumulates the
 *     stable windows: the interim line GROWS with the whole story and the
 *     final carries the complete utterance.
 *
 *  2. Plain interims (is_final=false) keep flowing as partials — each one
 *     prefixed with the accumulated stable text so the line never resets.
 *
 *  3. onSpeechStart (VAD, REQ-4 barge-in) fires once per utterance, on the
 *     FIRST non-empty result — including when that first result is already
 *     a stable window.
 *
 *  4. The endpointing final (is_final=true, speech_final=true) delivers the
 *     WHOLE utterance (stable prefix + last window) and resets the
 *     accumulator; the next utterance starts clean.
 *
 *  5. An empty final (silence gap closer) emits nothing.
 *
 *  6. A final whose last window is empty but whose stable windows had
 *     content still delivers the accumulated text (nothing lost).
 *
 *  7. No API key → connect() rejects with the configuration error.
 */

import { describe, expect, it } from 'bun:test';
import {
  DeepgramStreamingTranscriptionProvider,
} from '../../src/services/transcription/DeepgramStreamingTranscriptionProvider';
import type { StreamingTranscriptionCallbacks } from '../../src/services/transcription/IStreamingTranscriptionProvider';

// ---------------------------------------------------------------------------
// Fake WebSocket (ws-package-compatible subset)
// ---------------------------------------------------------------------------

const OPEN = 1;

class FakeWs {
  sent: string[] = [];
  closed = false;
  readyState = OPEN;
  handlers: Record<string, ((...args: any[]) => void)[]> = {};

  constructor(public url: string, public opts?: any) {
    // Async open, like a real WS.
    queueMicrotask(() => this.emit('open'));
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
  send = (data: string) => { this.sent.push(data); };
  close = () => { this.closed = true; };

  emit(event: string, ...args: any[]) {
    for (const h of this.handlers[event] ?? []) h(...args);
  }

  /** Test helper: simulate a Deepgram Results message. */
  results(transcript: string, is_final: boolean, speech_final: boolean) {
    this.emit(
      'message',
      Buffer.from(JSON.stringify({
        type: 'Results',
        channel: { alternatives: [{ transcript }] },
        is_final,
        speech_final,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeProvider() {
  const wsInstances: FakeWs[] = [];
  const provider = new DeepgramStreamingTranscriptionProvider({
    apiKey: 'test-key',
    wsImpl: class extends FakeWs {
      constructor(url: string, opts?: any) {
        super(url, opts);
        wsInstances.push(this as unknown as FakeWs);
      }
    },
  });
  const interims: string[] = [];
  const finals: string[] = [];
  const speechStarts: number[] = [];
  const callbacks: StreamingTranscriptionCallbacks = {
    onInterim: (text) => interims.push(text),
    onSpeechStart: () => speechStarts.push(interims.length + finals.length),
    onFinal: (text) => finals.push(text),
    onError: () => {},
  };
  return { provider, wsInstances, interims, finals, speechStarts, callbacks };
}

async function connect(h: ReturnType<typeof makeProvider>) {
  await h.provider.connect(h.callbacks, { languageCode: 'es' });
  // The fake WS opens on a microtask — let it land.
  await new Promise((r) => queueMicrotask(r));
  return h.wsInstances[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeepgramStreamingTranscriptionProvider', () => {
  it('accumulates stable windows: a long utterance keeps its WHOLE text (the long-story bug)', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    // The user tells a long story without pausing. Deepgram closes stable
    // windows along the way (is_final=true, speech_final=false) and every
    // later Results only carries the NEW window.
    ws.results('te voy a contar una historia', false, false); // interim
    ws.results('te voy a contar una historia', true, false); // window 1 closes
    ws.results('que empezó el lunes', false, false); // interim of window 2
    ws.results('que empezó el lunes', true, false); // window 2 closes
    ws.results('cuando llegué a la oficina', false, false); // interim of window 3
    // The user finally stops → endpointing final with only the last window.
    ws.results('cuando llegué a la oficina', true, true);

    // The interim line GREW with the story — it never reset to a fragment.
    expect(h.interims).toEqual([
      'te voy a contar una historia',
      'te voy a contar una historia',
      'te voy a contar una historia que empezó el lunes',
      'te voy a contar una historia que empezó el lunes',
      'te voy a contar una historia que empezó el lunes cuando llegué a la oficina',
    ]);

    // ONE final carrying the WHOLE utterance — not just the last phrase.
    expect(h.finals).toEqual([
      'te voy a contar una historia que empezó el lunes cuando llegué a la oficina',
    ]);
  });

  it('keeps emitting partials for plain interims, prefixed with the stable text', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('hola', true, false); // stable window
    ws.results('qué', false, false); // evolving interim of the next window
    ws.results('qué tal', false, false);

    expect(h.interims).toEqual([
      'hola',
      'hola qué',
      'hola qué tal',
    ]);
    expect(h.finals).toEqual([]);
  });

  it('fires onSpeechStart once per utterance, on the first non-empty result', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('hola', false, false);
    ws.results('hola', true, false);
    ws.results('más', false, false);
    ws.results('más', true, true);

    expect(h.speechStarts.length).toBe(1);

    // A second utterance fires it again.
    ws.results('otra cosa', false, false);
    expect(h.speechStarts.length).toBe(2);
  });

  it('fires onSpeechStart when the first result of an utterance is already a stable window', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('hola', true, false);
    expect(h.speechStarts.length).toBe(1);
    expect(h.interims).toEqual(['hola']);
  });

  it('the final resets the accumulator — the next utterance starts clean', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('primera frase', true, true);
    expect(h.finals).toEqual(['primera frase']);

    ws.results('segunda frase', false, false);
    ws.results('segunda frase', true, true);

    expect(h.finals).toEqual(['primera frase', 'segunda frase']);
    expect(h.interims).toEqual(['segunda frase']);
  });

  it('an empty final (silence gap closer) emits nothing', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('', true, true);
    expect(h.finals).toEqual([]);
    expect(h.interims).toEqual([]);
  });

  it('a final with an empty last window still delivers the accumulated stable text', async () => {
    const h = makeProvider();
    const ws = await connect(h);

    ws.results('todo lo estable', true, false);
    ws.results('', true, true); // empty last window — but the story was told

    expect(h.finals).toEqual(['todo lo estable']);
  });

  it('rejects connect() without an API key', async () => {
    const provider = new DeepgramStreamingTranscriptionProvider({});
    await expect(provider.connect({
      onInterim: () => {},
      onFinal: () => {},
      onError: () => {},
    })).rejects.toThrow('No Deepgram API key');
  });
});
