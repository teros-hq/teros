/**
 * F5d live latency benchmark — stream (WS stream-input) vs sentences (HTTP).
 *
 * Simulates a REAL voice turn: the LLM emits Spanish words one by one at a
 * realistic cadence (~30ms/word, ~33 words/s — a fast LLM's token rate).
 * Measures firstTextChunk→firstAudio for both providers against the REAL
 * ElevenLabs API:
 *
 *  - sentences (ElevenLabsFlashTtsProvider): audio only after the first full
 *    sentence has streamed in + one HTTP request.
 *  - stream (ElevenLabsStreamTtsProvider): the server starts generating at
 *    ~50 chars — audio mid-sentence.
 *
 * Not part of the unit suite — a manual measurement (bun run). No assertions;
 * prints the numbers for the task's progress note.
 */

import WebSocket from 'ws';
import { ElevenLabsFlashTtsProvider } from '../../src/services/tts/ElevenLabsFlashTtsProvider';
import { ElevenLabsStreamTtsProvider } from '../../src/services/tts/ElevenLabsStreamTtsProvider';
import type { TtsStreamCallbacks } from '../../src/services/tts/ITtsProvider';
import { readFileSync } from 'fs';

const key = JSON.parse(
  readFileSync('/opt/teros/.secrets/system/elevenlabs.json', 'utf8'),
).apiKey as string;

/** A realistic Spanish voice answer, word by word. */
const WORDS =
  'Claro, te explico cómo funciona el modo de voz: cuando hablas, el sistema ' +
  'transcribe tu audio en tiempo real y luego genera la respuesta. ' +
  'La clave está en que no esperamos a tener toda la frase para empezar a ' +
  'hablar, sino que vocalizamos a media frase, igual que haría una persona. ' +
  'Esto reduce muchísimo la latencia percibida.';

/** Realistic LLM cadence: ~30ms per word (fast model streaming). */
const WORD_INTERVAL_MS = 30;

interface Result {
  mode: string;
  firstTextChunkAt: number | null;
  firstAudioAt: number | null;
  ttsMs: number | null;
  totalChunks: number;
  endSeen: boolean;
}

function runTurn(
  mode: 'sentences' | 'stream',
  provider: { speak(c: TtsStreamCallbacks): void; feed(t: string): void; endOfText(): void; cancel(): void },
): Promise<Result> {
  return new Promise((resolve) => {
    const result: Result = {
      mode, firstTextChunkAt: null, firstAudioAt: null,
      ttsMs: null, totalChunks: 0, endSeen: false,
    };
    const t0 = Date.now();
    const callbacks: TtsStreamCallbacks = {
      onStart: () => {
        result.firstAudioAt = Date.now();
        result.ttsMs = result.firstTextChunkAt !== null
          ? result.firstAudioAt - result.firstTextChunkAt
          : null;
      },
      onChunk: () => { result.totalChunks += 1; },
      onEnd: () => {
        result.endSeen = true;
        resolve(result);
      },
      onError: (e) => {
        console.error(`[${mode}] ERROR:`, e.message);
        resolve(result);
      },
    };
    provider.speak(callbacks);
    // The LLM streams word by word at a realistic cadence.
    const words = WORDS.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (i < words.length) {
        if (i === 0) result.firstTextChunkAt = Date.now();
        provider.feed((i === 0 ? '' : ' ') + words[i]);
        i += 1;
      } else {
        clearInterval(timer);
        provider.endOfText();
      }
    }, WORD_INTERVAL_MS);
    // Safety: resolve anyway after 30s.
    setTimeout(() => resolve(result), 30_000).unref?.();
    void t0;
  });
}

async function main() {
  console.log(`Words: ${WORDS.split(' ').length}, cadence: ${WORD_INTERVAL_MS}ms/word\n`);

  // ── sentences (current, HTTP per sentence) ──────────────────────────────
  const sentences = new ElevenLabsFlashTtsProvider({ apiKey: key });
  const r1 = await runTurn('sentences', sentences);
  console.log(`[sentences] firstTextChunk→firstAudio: ${r1.ttsMs}ms | chunks: ${r1.totalChunks} | end: ${r1.endSeen}`);

  // ── stream (F5d, WS stream-input) ──────────────────────────────────────
  const stream = new ElevenLabsStreamTtsProvider({
    apiKey: key,
    wsImpl: WebSocket as any,
  });
  const r2 = await runTurn('stream', stream);
  console.log(`[stream]    firstTextChunk→firstAudio: ${r2.ttsMs}ms | chunks: ${r2.totalChunks} | end: ${r2.endSeen}`);

  if (r1.ttsMs !== null && r2.ttsMs !== null) {
    const saved = r1.ttsMs - r2.ttsMs;
    const pct = Math.round((saved / r1.ttsMs) * 100);
    console.log(`\nΔ: stream saves ${saved}ms (${pct}%) of the TTS segment at first audio.`);
  }
  process.exit(0);
}

void main();
