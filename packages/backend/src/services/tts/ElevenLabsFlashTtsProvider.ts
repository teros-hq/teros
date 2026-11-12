/**
 * ElevenLabs Flash TTS Provider — streaming sentence synthesis
 *
 * Voice Mode v2 — F1a (spec v1.1.0 REQ-3): the native voice loop's TTS.
 * Implements `ITtsProvider` over the ElevenLabs text-to-speech HTTP API
 * (`POST /v1/text-to-speech/{voiceId}`) with the low-latency Flash model
 * (`eleven_flash_v2_5`), same voice and call pattern as the platform's
 * ElevenLabs MCA (`mcas/mca.elevenlabs/src/index.ts`).
 *
 * Streaming strategy: the loop feeds assistant text deltas as they arrive;
 * this provider buffers them and, at each sentence boundary, synthesizes that
 * sentence immediately (one HTTP request per sentence). Audio for early
 * sentences flows to the client while later text is still generating —
 * time-to-first-audio ≈ first sentence + one Flash request.
 *
 * API key: `.secrets/system/elevenlabs.json` → `{ "apiKey": "..." }` (same
 * secret as the legacy ConvAI engine — one vendor, two uses). Explicit apiKey
 * in the constructor config wins (tests' injection point).
 *
 * Barge-in (REQ-4): `cancel()` drops pending sentences and in-flight requests
 * (AbortController); no callbacks fire after cancel() returns.
 */

import type { ITtsProvider, TtsStreamCallbacks } from './ITtsProvider';

/** Platform default voice — Azu M (Calm & professional & spanish). Matches the voice session engine default. */
const DEFAULT_VOICE_ID = '4v1uoUi065MedHZMinXC';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

export interface ElevenLabsFlashTtsConfig {
  /** ElevenLabs API key. When omitted, resolved from SecretsManager by the caller. */
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  /** API base (tests). */
  apiBase?: string;
  /** fetch override (tests — no real network). */
  fetchImpl?: typeof fetch;
}

/** Sentence boundary: . ! ? … ; followed by whitespace/end. */
const SENTENCE_BOUNDARY = /([.!?…;])\s+/;

export class ElevenLabsFlashTtsProvider implements ITtsProvider {
  private callbacks: TtsStreamCallbacks | null = null;
  private buffer = '';
  private active = false;
  private cancelled = false;
  private started = false;
  /** FIFO of pending sentence syntheses; one at a time keeps audio ordered. */
  private queue: string[] = [];
  private draining = false;
  private endOfTextSignalled = false;
  private abort: AbortController | null = null;

  constructor(private config: ElevenLabsFlashTtsConfig = {}) {}

  speak(callbacks: TtsStreamCallbacks): void {
    if (this.active) this.cancel();
    this.callbacks = callbacks;
    this.buffer = '';
    this.queue = [];
    this.active = true;
    this.cancelled = false;
    this.started = false;
    this.endOfTextSignalled = false;
    this.abort = new AbortController();
  }

  feed(text: string): void {
    if (!this.active || this.cancelled || !text) return;
    this.buffer += text;
    this.flushSentences(false);
  }

  endOfText(): void {
    if (!this.active || this.cancelled) return;
    this.endOfTextSignalled = true;
    // Whatever is left in the buffer is the final unit — flush it.
    this.flushSentences(true);
    void this.drain();
  }

  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.active = false;
    this.abort?.abort();
    this.queue = [];
    this.buffer = '';
    this.callbacks = null;
  }

  isSpeaking(): boolean {
    return this.active && !this.cancelled;
  }

  /**
   * Move complete sentences from the buffer to the synthesis queue.
   * `final=true` (endOfText) flushes the remainder even without punctuation.
   */
  flush(): void {
    if (!this.active || this.cancelled) return;
    // Treat the partial buffer as a sentence (same as endOfText does), but
    // keep the turn open: `endOfTextSignalled` stays false so drain() does not
    // fire onEnd.
    this.flushSentences(true);
  }

  private flushSentences(final: boolean): void {
    if (this.cancelled) return;

    // Extract every complete sentence (boundary + following whitespace).
    // A non-global regex always matches from the start, so each iteration
    // finds the first boundary of the remaining buffer, slices it off, and
    // repeats until no boundary is left.
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_BOUNDARY.exec(this.buffer)) !== null) {
      if (this.cancelled) return;
      const boundaryEnd = match.index + match[0].length;
      const sentence = this.buffer.slice(0, boundaryEnd).trim();
      this.buffer = this.buffer.slice(boundaryEnd);
      if (sentence) this.queue.push(sentence);
    }

    if (final && this.buffer.trim()) {
      this.queue.push(this.buffer.trim());
      this.buffer = '';
    }

    if (this.queue.length > 0) void this.drain();
  }

  /** Synthesize queued sentences one at a time (audio order = text order). */
  private async drain(): Promise<void> {
    if (this.draining || this.cancelled) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.cancelled) {
        const sentence = this.queue.shift()!;
        await this.synthesizeSentence(sentence);
      }
      // Done when the queue is empty AND the text ended AND audio drained.
      if (
        !this.cancelled &&
        this.endOfTextSignalled &&
        this.queue.length === 0 &&
        this.active
      ) {
        this.active = false;
        this.callbacks?.onEnd();
      }
    } finally {
      this.draining = false;
    }
  }

  private async synthesizeSentence(sentence: string): Promise<void> {
    if (this.cancelled) return;
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      this.fail(new Error(
        'No ElevenLabs API key available for TTS.\n' +
        'Configure it in .secrets/system/elevenlabs.json: { "apiKey": "..." }',
      ));
      return;
    }

    const voiceId = this.config.voiceId ?? DEFAULT_VOICE_ID;
    const modelId = this.config.modelId ?? DEFAULT_MODEL_ID;
    const outputFormat = this.config.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
    const apiBase = this.config.apiBase ?? 'https://api.elevenlabs.io/v1';
    const doFetch = this.config.fetchImpl ?? fetch;

    try {
      const response = await doFetch(
        `${apiBase}/text-to-speech/${voiceId}?output_format=${outputFormat}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text: sentence,
            model_id: modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0,
              use_speaker_boost: true,
            },
          }),
          signal: this.abort?.signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        this.fail(new Error(`ElevenLabs TTS error: ${response.status} ${response.statusText} ${errorText}`));
        return;
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (this.cancelled) return; // Barge-in landed mid-request — drop the audio.

      if (!this.started) {
        this.started = true;
        this.callbacks?.onStart(); // First audio → activity 'speaking'.
      }
      // Deliver in ordered chunks (~4KB base64 frames keep the WS happy).
      const CHUNK = 3 * 1024; // bytes of raw audio per frame
      for (let i = 0; i < audio.length; i += CHUNK) {
        if (this.cancelled) return;
        this.callbacks?.onChunk(audio.subarray(i, i + CHUNK).toString('base64'));
      }
      // One sentence = one decodable segment; the HTTP endpoint has no timing.
      this.callbacks?.onSegment?.(null);
    } catch (err) {
      if (this.cancelled || (err as any)?.name === 'AbortError') return; // Barge-in.
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private fail(error: Error): void {
    if (this.cancelled) return;
    this.active = false;
    this.queue = [];
    const cb = this.callbacks;
    this.callbacks = null;
    cb?.onError(error);
  }
}
