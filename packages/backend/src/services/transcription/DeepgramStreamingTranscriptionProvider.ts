/**
 * Deepgram Streaming Transcription Provider — Nova-3
 *
 * Voice Mode v2 — F1a (spec v1.1.0 REQ-1): streaming speech-to-text over the
 * Deepgram WebSocket (`wss://api.deepgram.com/v1/listen`). Push-based: base64
 * PCM chunks in, interim/final transcripts out, one utterance at a time.
 *
 * - Interim (is_final=false) → onInterim — the voice loop forwards them to the
 *   frontend as `transcript { partial: true }` frames.
 * - Stable window (is_final=true, speech_final=false) → ACCUMULATED in
 *   `stablePrefix` — Deepgram closes stable audio windows while the user is
 *   still speaking, and every later Results message only carries the NEW
 *   window's transcript. Without accumulating, a long continuous utterance
 *   lost everything but the last window (the interim line was overwritten
 *   with the latest fragment and the final only contained the last one).
 * - Final (is_final=true, speech_final=true) → onFinal — the utterance
 *   boundary that enters the pipeline (persistence + Teros agent turn),
 *   carrying the WHOLE utterance (stablePrefix + the last window).
 * - Endpointing (ms of silence that close an utterance) is configurable —
 *   the Spanish turn-taking risk knob from the spec (§Fase 1 riesgo).
 *
 * API key: `.secrets/system/deepgram.json` → `{ "apiKey": "..." }`
 * (auto-discovered by SecretsManager). Explicit apiKey in the constructor
 * config wins — that's the tests' injection point.
 */

import WebSocket from 'ws';
import type {
  IStreamingTranscriptionProvider,
  StreamingTranscriptionCallbacks,
  StreamingTranscriptionConfig,
} from './IStreamingTranscriptionProvider';

export interface DeepgramStreamingProviderConfig {
  /** Deepgram API key. When omitted, resolved from SecretsManager by the caller. */
  apiKey?: string;
  /** Model id. Default 'nova-3'. */
  model?: string;
  /** Deepgram endpointing ms. Default 300. */
  endpointingMs?: number;
  /** Language. Default 'es' (platform default, Pablo speaks Spanish). */
  languageCode?: string;
  /** Vocabulary terms for accuracy biasing (keyterm feature). */
  vocabulary?: string[] | null;
  /** Override the WebSocket URL (tests). */
  url?: string;
  /**
   * Override the WebSocket constructor (tests — fake WS, no real network).
   * Must be compatible with the `ws` package's client shape (on/once/send/
   * close/removeListener, readyState).
   */
  wsImpl?: new (url: string, opts?: { headers: Record<string, string> }) => any;
}

/** Deepgram message shapes (subset the loop cares about). */
interface DeepgramResult {
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
}

interface DeepgramResponseMessage {
  type: string;
  channel?: DeepgramResult['channel'];
  is_final?: boolean;
  speech_final?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class DeepgramStreamingTranscriptionProvider implements IStreamingTranscriptionProvider {
  private ws: WebSocket | null = null;
  private callbacks: StreamingTranscriptionCallbacks | null = null;
  private closed = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Inside an utterance (first interim seen, final not yet delivered). */
  private inUtterance = false;
  /**
   * Accumulated STABLE transcript of the current utterance (is_final=true,
   * speech_final=false windows). Deepgram closes stable windows while the
   * user keeps talking and later Results only carry the new window — this
   * prefix is what keeps the WHOLE utterance in the interim line and the
   * final. Cleared when the utterance ends (speech_final) or a new one
   * begins (first non-empty interim after a final).
   */
  private stablePrefix = '';

  constructor(private config: DeepgramStreamingProviderConfig = {}) {}

  async connect(
    callbacks: StreamingTranscriptionCallbacks,
    config?: StreamingTranscriptionConfig,
  ): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error(
        'No Deepgram API key available for streaming transcription.\n' +
          'Configure it in .secrets/system/deepgram.json:\n' +
          '  { "apiKey": "<your-deepgram-api-key>" }',
      );
    }

    this.callbacks = callbacks;
    this.closed = false;

    const model = this.config.model ?? 'nova-3';
    const language = config?.languageCode ?? this.config.languageCode ?? 'es';
    // Tunable chain (F1b intact, F5b feeds it): per-connect config (the
    // voice loop's voice.endpointing-ms flag, default 200) > provider config
    // > 300 (the pre-F5b hardcoded default, kept as the last resort).
    const endpointing = config?.endpointingMs ?? this.config.endpointingMs ?? 300;
    const vocabulary = config?.vocabulary ?? this.config.vocabulary ?? null;

    const params = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      language,
      smart_format: 'true',
      interim_results: 'true',
      endpointing: String(endpointing),
    });
    // Vocabulary biasing: Deepgram keyterm (comma-joined, capped for URL sanity).
    if (vocabulary && vocabulary.length > 0) {
      params.set('keyterm', vocabulary.slice(0, 50).join(','));
    }

    const url =
      this.config.url ??
      `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const WsCtor = (this.config as any).wsImpl ?? WebSocket;
      const ws = new WsCtor(url, {
        headers: { Authorization: `Token ${this.config.apiKey}` },
      });
      this.ws = ws;

      const onError = (err: Error) => {
        this.ws = null;
        reject(new Error(`Deepgram STT connection failed: ${err.message}`));
      };
      ws.once('error', onError);

      ws.on('open', () => {
        ws.removeListener('error', onError);
        ws.on('error', (err: Error) => {
          // Post-open failures go to the loop as provider errors.
          this.callbacks?.onError(new Error(`Deepgram STT error: ${err.message}`));
        });
        // KeepAlive: Deepgram closes idle streaming connections (~10s without
        // audio). The client VAD only sends audio while the user speaks
        // (REQ-5: silence ≈ $0), so ping every 5s to hold the connection open
        // through silence without streaming audio.
        this.keepAliveTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 5000);
        resolve();
      });

      ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        this.ws = null;
        if (!this.closed) {
          // Unexpected close — surface to the loop (typed stt_error upstream).
          this.callbacks?.onError(new Error('Deepgram STT connection closed unexpectedly'));
        }
        this.callbacks?.onClose?.();
      });
    });
  }

  private handleMessage(raw: string): void {
    let msg: DeepgramResponseMessage;
    try {
      msg = JSON.parse(raw) as DeepgramResponseMessage;
    } catch {
      return; // Non-JSON frame — ignore.
    }

    if (msg.type === 'error' || (msg as any).error) {
      this.callbacks?.onError(new Error(`Deepgram STT error: ${(msg as any).error ?? 'unknown'}`));
      return;
    }

    if (msg.type !== 'Results') return;

    const transcript = msg.channel?.alternatives?.[0]?.transcript ?? '';
    // Deepgram: is_final = a stable window; speech_final = the endpointing
    // boundary (utterance complete). An empty final just closes a silence
    // gap — not an utterance, don't emit it.
    if (msg.is_final && msg.speech_final) {
      this.inUtterance = false;
      // The utterance's WHOLE text: every stable window accumulated while the
      // user kept talking + this last window's transcript. (Also rescues the
      // case where the last window is empty but stable windows had content.)
      const whole = `${this.stablePrefix} ${transcript}`.trim();
      this.stablePrefix = '';
      if (whole) this.callbacks?.onFinal(whole);
    } else if (transcript.trim()) {
      // First non-empty result of a new utterance → VAD speech start
      // (REQ-4 barge-in). Fires once per utterance, before any stable
      // transcript exists — the loop cuts the TTS without waiting for final.
      if (!this.inUtterance) {
        this.inUtterance = true;
        this.stablePrefix = '';
        this.callbacks?.onSpeechStart?.();
      }
      if (msg.is_final) {
        // Stable window while the user is STILL speaking (speech_final=false):
        // Deepgram has closed this audio window and will never revise it —
        // later Results only carry the next window. Accumulate it so the
        // interim line and the eventual final keep the whole utterance.
        this.stablePrefix = `${this.stablePrefix} ${transcript.trim()}`.trim();
        this.callbacks?.onInterim(this.stablePrefix);
      } else {
        // Interim (still revisable): the accumulated stable prefix + the
        // evolving window — the line GROWS with the story, never resets.
        const partial = this.stablePrefix
          ? `${this.stablePrefix} ${transcript.trim()}`
          : transcript.trim();
        this.callbacks?.onInterim(partial);
      }
    }
  }

  sendAudio(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Deepgram accepts raw binary frames of linear16 PCM.
    this.ws.send(Buffer.from(base64Audio, 'base64'));
  }

  close(): void {
    this.closed = true;
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // CloseStream tells Deepgram to flush pending finals, then closes.
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.ws?.close();
    this.ws = null;
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
