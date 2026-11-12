/**
 * ElevenLabs Stream-Input TTS Provider — WebSocket incremental synthesis
 *
 * Voice Mode v2 — F5d (spec v1.1.0 REQ-3): the native voice loop's TTS over
 * the ElevenLabs `stream-input` WebSocket
 * (`wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input`).
 *
 * Why: the sentence provider (ElevenLabsFlashTtsProvider, kept as fallback)
 * waits for a full sentence boundary before its first HTTP request — the
 * first audio only starts after the WHOLE first sentence has streamed in
 * from the LLM. The stream-input WS is built exactly for incremental LLM
 * text: deltas are pushed word-by-word and the server starts generating at
 * the first `chunk_length_schedule` threshold (50 chars) — half a sentence
 * can already be vocalized, like Vapi/Retell/ElevenLabs ConvAI do.
 *
 * Protocol (ElevenLabs stream-input):
 *  - `bos` (beginning of stream): voice_id, model_id, output_format +
 *    `generation_config.chunk_length_schedule: [50, 100, 180, 250]` — the
 *    server starts generating when the accumulated text reaches the first
 *    threshold and grows the window for better prosody on later sentences.
 *  - `{ text }` messages: incremental deltas, exactly as the LLM emits them
 *    (word-by-word). The server accumulates context for natural prosody.
 *  - final empty `{ text: "" }`: flushes the buffer — the remaining audio
 *    drains and the server closes the synthesis.
 *  - Responses: `{ audio: <base64>, isFinal: bool }` frames in order.
 *
 * Contract: identical to the sentence provider — `ITtsProvider`
 * (speak/feed/endOfText/cancel) with the same callbacks
 * (onStart/onChunk/onEnd/onError). The voice loop and the frontend player
 * (F3d FIFO) do not change; only WHEN synthesis starts changes.
 *
 * Resilience:
 *  - If the WS fails to connect or dies mid-turn, the turn degrades to the
 *    sentence provider (HTTP per sentence) transparently — the buffered
 *    text is replayed into it, so no spoken word is lost. After 2+ WS
 *    failures the provider stays on the fallback permanently (a bad WS
 *    night should not degrade every turn) until the next connection
 *    recreates the provider.
 *  - `cancel()` (barge-in, REQ-4) closes the WS immediately — no orphan
 *    audio can arrive after it returns (<300ms cut, AC-5).
 *
 * API key: same secret as the sentence provider —
 * `.secrets/system/elevenlabs.json` → `{ "apiKey": "..." }`. Explicit apiKey
 * in the constructor config wins (tests' injection point).
 */

import WebSocket from 'ws';
import type { ITtsProvider, TtsAlignment, TtsStreamCallbacks } from './ITtsProvider';
import { ElevenLabsFlashTtsProvider } from './ElevenLabsFlashTtsProvider';

/** Platform default voice — Azu M (Calm & professional & spanish). Matches the voice session engine default. */
const DEFAULT_VOICE_ID = '4v1uoUi065MedHZMinXC';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/**
 * When the server starts generating: 50 chars ≈ half a short sentence.
 * Later thresholds grow the synthesis window for better prosody — the
 * official recommendation for incremental LLM text.
 */
const DEFAULT_CHUNK_LENGTH_SCHEDULE = [50, 100, 180, 250];

/** After this many WS failures in a row, stay on the sentence fallback. */
const MAX_WS_FAILURES = 2;

/** Seconds without a WS frame before the connection is considered dead. */
const WS_IDLE_TIMEOUT_MS = 30_000;

export interface ElevenLabsStreamTtsConfig {
  /** ElevenLabs API key. When omitted, resolved from SecretsManager by the caller. */
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  outputFormat?: string;
  /** chunk_length_schedule for the bos message. Default [50, 100, 180, 250]. */
  chunkLengthSchedule?: number[];
  /** API base (tests). Default 'wss://api.elevenlabs.io/v1'. */
  wsBase?: string;
  /**
   * WebSocket constructor override (tests — no real network). Must be
   * compatible with the `ws` package's client shape (on/once/send/close,
   * readyState constants).
   */
  wsImpl?: new (url: string, opts?: { headers: Record<string, string> }) => any;
  /** fetch override for the fallback sentence provider (tests). */
  fetchImpl?: typeof fetch;
}

/** Server → client frame shape (subset we care about). */
interface StreamInputResponse {
  audio?: string;
  isFinal?: boolean;
  message?: string;
  /** Character timing of THIS chunk (sync_alignment=true), input text. */
  alignment?: Partial<TtsAlignment> | null;
  /** Same, for the normalized text (numbers expanded etc.). */
  normalizedAlignment?: Partial<TtsAlignment> | null;
  [key: string]: unknown;
}

/** Validate the three parallel arrays; null when absent or inconsistent. */
function readAlignment(raw: Partial<TtsAlignment> | null | undefined): TtsAlignment | null {
  if (!raw || !Array.isArray(raw.chars) || !Array.isArray(raw.charStartTimesMs) || !Array.isArray(raw.charDurationsMs)) {
    return null;
  }
  const n = raw.chars.length;
  if (n === 0 || raw.charStartTimesMs.length !== n || raw.charDurationsMs.length !== n) return null;
  return {
    chars: raw.chars.map(String),
    charStartTimesMs: raw.charStartTimesMs.map(Number),
    charDurationsMs: raw.charDurationsMs.map(Number),
  };
}

export class ElevenLabsStreamTtsProvider implements ITtsProvider {
  private callbacks: TtsStreamCallbacks | null = null;
  private ws: any = null;
  /** Deltas fed while the WS connects — pushed one by one, in order, on open. */
  private pending: string[] = [];
  /** Text fed this turn, kept whole — replayed into the fallback on WS death. */
  private fedText = '';
  private active = false;
  private cancelled = false;
  private started = false;
  private endOfTextSignalled = false;
  /** WS is open and accepting deltas for the current turn. */
  private wsTurnOpen = false;
  private wsFailures = 0;
  /** The sentence fallback — created lazily, only on WS failure. */
  private fallback: ElevenLabsFlashTtsProvider | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: ElevenLabsStreamTtsConfig = {}) {}

  speak(callbacks: TtsStreamCallbacks): void {
    if (this.active) this.cancel();
    this.callbacks = callbacks;
    this.pending = [];
    this.fedText = '';
    this.active = true;
    this.cancelled = false;
    this.started = false;
    this.endOfTextSignalled = false;
    this.wsTurnOpen = false;
    if (this.wsFailures >= MAX_WS_FAILURES) {
      // WS already proven broken this session — go straight to the fallback.
      this.startFallback();
      return;
    }
    this.openTurnWs();
  }

  feed(text: string): void {
    if (!this.active || this.cancelled || !text) return;
    if (this.fallback) {
      this.fallback.feed(text);
      return;
    }
    this.fedText += text;
    if (this.wsTurnOpen) {
      this.pushDelta(text);
    } else {
      // WS still connecting — buffer; each delta pushes on open, in order.
      this.pending.push(text);
    }
  }

  endOfText(): void {
    if (!this.active || this.cancelled) return;
    this.endOfTextSignalled = true;
    if (this.fallback) {
      this.fallback.endOfText();
      return;
    }
    if (this.wsTurnOpen) {
      // The final empty message flushes the server's remaining buffer.
      this.wsSend({ text: '' });
    }
    // If the WS is still connecting, the flush rides on open (see openTurnWs).
  }

  flush(): void {
    if (!this.active || this.cancelled || this.endOfTextSignalled) return;
    if (this.fallback) {
      this.fallback.flush();
      return;
    }
    // `flush: true` makes the server generate the buffered text right away
    // regardless of chunk_length_schedule; the turn stays open for more text.
    if (this.wsTurnOpen) this.wsSend({ text: ' ', flush: true });
    // Still connecting: the buffered deltas ride on open and the next flush
    // (or endOfText) will catch up — a flush before any text is a no-op.
  }

  cancel(): void {
    if (!this.active && !this.ws) return;
    this.cancelled = true;
    this.active = false;
    this.fallback?.cancel();
    this.fallback = null;
    this.closeWs();
    this.pending = [];
    this.fedText = '';
    this.callbacks = null;
  }

  isSpeaking(): boolean {
    if (this.fallback) return this.fallback.isSpeaking();
    return this.active && !this.cancelled;
  }

  // -------------------------------------------------------------------------
  // WebSocket turn lifecycle
  // -------------------------------------------------------------------------

  /** Open (or reuse) the WS and send the bos message for this turn. */
  private openTurnWs(): void {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      this.failTurn(new Error(
        'No ElevenLabs API key available for TTS.\n' +
        'Configure it in .secrets/system/elevenlabs.json: { "apiKey": "..." }',
      ));
      return;
    }

    const voiceId = this.config.voiceId ?? DEFAULT_VOICE_ID;
    const modelId = this.config.modelId ?? DEFAULT_MODEL_ID;
    const wsBase = this.config.wsBase ?? 'wss://api.elevenlabs.io/v1';

    // sync_alignment: every audio message carries the character timing of
    // that chunk (PoC 2026-10-31 — exact barge-in cut + spoken-text marking).
    const url =
      `${wsBase}/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&sync_alignment=true`;

    const WsCtor = this.config.wsImpl ?? WebSocket;
    let ws: any;
    try {
      ws = new WsCtor(url, { headers: { 'xi-api-key': apiKey } });
    } catch (err) {
      this.handleWsFailure(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = ws;

    const onOpenError = (err: Error) => {
      if (this.ws === ws) this.handleWsFailure(err);
    };
    ws.once('error', onOpenError);

    ws.on('open', () => {
      if (this.cancelled || this.ws !== ws) { ws.close(); return; }
      ws.removeListener('error', onOpenError);
      ws.on('error', (err: Error) => {
        // Post-open errors: the turn is dead — degrade to the fallback.
        if (this.ws === ws) this.handleWsFailure(err);
      });
      // bos — the chunk schedule is the whole point of F5d: the server
      // starts synthesizing at 50 chars, not at a sentence boundary.
      this.wsSend({
        text: ' ',
        voice_id: voiceId,
        model_id: modelId,
        output_format: this.config.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
        generation_config: {
          chunk_length_schedule:
            this.config.chunkLengthSchedule ?? DEFAULT_CHUNK_LENGTH_SCHEDULE,
        },
      });
      this.wsTurnOpen = true;
      // Deltas that arrived while connecting — push them now, one by one,
      // in feed order (the server accumulates them as context).
      while (this.pending.length > 0) {
        this.pushDelta(this.pending.shift()!);
      }
      // endOfText already signalled (short ack turn: speak→feed→endOfText
      // before the WS finished opening) — flush immediately.
      if (this.endOfTextSignalled) this.wsSend({ text: '' });
      this.armIdleTimer();
    });

    ws.on('message', (data: Buffer) => {
      if (this.cancelled || this.ws !== ws) return;
      this.handleServerFrame(data.toString());
    });

    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsTurnOpen = false;
      this.clearIdleTimer();
      if (!this.cancelled && this.active) {
        // Died mid-turn — degrade to the sentence fallback, replay the text.
        this.handleWsFailure(new Error('ElevenLabs stream-input WS closed mid-turn'));
      }
    });
  }

  /** Push one text delta to the WS (word-by-word, as the LLM emits). */
  private pushDelta(text: string): void {
    this.wsSend({ text });
  }

  /** Safe send: a dead WS degrades to the fallback instead of throwing. */
  private wsSend(message: object): void {
    if (!this.ws) return;
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      } else {
        // Not open — the frame is lost; treat as a WS failure.
        this.handleWsFailure(new Error('ElevenLabs stream-input WS not open'));
      }
    } catch (err) {
      this.handleWsFailure(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** One server frame: base64 audio in order, isFinal ends the turn. */
  private handleServerFrame(raw: string): void {
    let msg: StreamInputResponse;
    try {
      msg = JSON.parse(raw) as StreamInputResponse;
    } catch {
      return; // Non-JSON frame — ignore.
    }
    if (typeof msg.message === 'string' && !msg.audio) {
      // Server-side error notice (e.g. quota/auth) — degrade, don't crash.
      this.handleWsFailure(new Error(`ElevenLabs stream-input error: ${msg.message}`));
      return;
    }
    if (typeof msg.audio === 'string' && msg.audio.length > 0) {
      if (!this.started) {
        this.started = true;
        this.callbacks?.onStart(); // First audio → activity 'speaking'.
      }
      // Deliver in ordered chunks (~3KB base64 frames, same as the sentence
      // provider — the client player (F3d FIFO) is format-agnostic).
      const CHUNK = 3 * 1024;
      for (let i = 0; i < msg.audio.length; i += CHUNK) {
        if (this.cancelled) return;
        this.callbacks?.onChunk(msg.audio.slice(i, i + CHUNK));
      }
      // One server message = one decodable segment. The input-text alignment
      // maps 1:1 onto the fed deltas (the normalized one re-spells numbers).
      this.callbacks?.onSegment?.(readAlignment(msg.alignment) ?? readAlignment(msg.normalizedAlignment));
    }
    if (msg.isFinal) {
      this.finishTurn();
    }
    this.armIdleTimer();
  }

  /** Turn fully drained — close the WS and report onEnd. */
  private finishTurn(): void {
    if (!this.active || this.cancelled) return;
    this.active = false;
    this.closeWs();
    const cb = this.callbacks;
    this.callbacks = null;
    this.wsTurnOpen = false;
    cb?.onEnd();
  }

  /**
   * WS failure (connect error, mid-turn death, server error notice).
   * Degrade this turn to the sentence provider replaying everything fed
   * so far; after MAX_WS_FAILURES the provider stays on the fallback.
   */
  private handleWsFailure(err: Error): void {
    if (this.cancelled) return;
    this.wsFailures += 1;
    const turnActive = this.active;
    const endSignalled = this.endOfTextSignalled;
    this.closeWs();
    this.wsTurnOpen = false;
    if (!turnActive) return; // No turn in flight — nothing to degrade.

    console.warn(
      `[TTS stream-input] WS failure #${this.wsFailures} — degrading to sentence fallback: ${err.message}`,
    );
    this.startFallback();
    // Replay the whole turn's text into the fallback — no spoken word lost.
    if (this.fedText) this.fallback?.feed(this.fedText);
    if (endSignalled) this.fallback?.endOfText();
  }

  /** Create (or reuse) the sentence provider and hand it the turn. */
  private startFallback(): void {
    if (!this.callbacks) return;
    this.fallback = new ElevenLabsFlashTtsProvider({
      apiKey: this.config.apiKey,
      voiceId: this.config.voiceId,
      modelId: this.config.modelId,
      outputFormat: this.config.outputFormat,
      fetchImpl: this.config.fetchImpl,
    });
    this.fallback.speak(this.callbacks);
  }

  /** Terminal failure — report onError and reset the turn state. */
  private failTurn(error: Error): void {
    if (this.cancelled) return;
    this.active = false;
    this.closeWs();
    const cb = this.callbacks;
    this.callbacks = null;
    this.wsTurnOpen = false;
    cb?.onError(error);
  }

  private closeWs(): void {
    this.clearIdleTimer();
    const ws = this.ws;
    this.ws = null;
    this.wsTurnOpen = false;
    if (ws) {
      try { ws.removeAllListeners?.(); } catch { /* best effort */ }
      try { ws.close(); } catch { /* best effort */ }
    }
  }

  /**
   * Idle watchdog: a healthy turn receives frames (audio/isFinal) or is
   * still being fed text. No frames and no text for WS_IDLE_TIMEOUT_MS
   * means the WS is a zombie — degrade to the fallback instead of hanging
   * the turn forever.
   */
  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.active && !this.cancelled && !this.fallback) {
        this.handleWsFailure(new Error('ElevenLabs stream-input WS idle timeout'));
      }
    }, WS_IDLE_TIMEOUT_MS);
    (this.idleTimer as any).unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
