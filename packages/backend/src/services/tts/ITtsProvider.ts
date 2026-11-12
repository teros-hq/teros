/**
 * TTS Provider Interface
 *
 * Voice Mode v2 — F1a (spec v1.1.0 REQ-3): streaming text-to-speech for the
 * native voice loop. Providers (ElevenLabs Flash, later Cartesia/CSM-1B)
 * implement this; the voice loop consumes it and never talks to a vendor SDK
 * directly, so TTS stays a swappable commodity (NFR-5).
 *
 * Streaming contract: the loop feeds text as it arrives (assistant deltas),
 * the provider flushes speakable units (sentences) as they complete, and
 * delivers base64 audio chunks in order, bracketed by onStart/onEnd so the
 * client can drive the `speaking` activity state.
 */

/**
 * Character-level timing of one audio segment (ElevenLabs `alignment`):
 * parallel arrays, times relative to the START OF THAT SEGMENT.
 */
export interface TtsAlignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

/** Events the voice loop registers on the TTS stream. */
export interface TtsStreamCallbacks {
  /** First audio chunk of a synthesis stream is about to be sent (activity → speaking). */
  onStart: () => void;
  /** One base64 audio chunk, in order. Sent to the client as `tts_chunk` frames. */
  onChunk: (base64Audio: string) => void;
  /**
   * PoC 2026-10-31: the chunks emitted since the previous onSegment form ONE
   * independently decodable audio segment (one provider message / one
   * sentence). `alignment` is its character timing when the provider has it
   * (stream-input WS), null otherwise (sentence HTTP provider).
   */
  onSegment?: (alignment: TtsAlignment | null) => void;
  /** The stream fully drained (activity → idle). Not called after cancel(). */
  onEnd: () => void;
  /** Provider failure mid-stream. The stream is dead after this. */
  onError: (error: Error) => void;
}

export interface TtsProviderConfig {
  /** Voice id. Provider-specific; the default is the platform voice. */
  voiceId?: string;
  /** Provider model id. Default: the provider's low-latency model. */
  modelId?: string;
  /** Output format (provider-specific, e.g. 'mp3_44100_128'). */
  outputFormat?: string;
}

/**
 * Streaming TTS provider. One instance per voice session; the loop owns the
 * lifecycle: `speak(text, callbacks)` per agent turn, `feed()` for incremental
 * text, `cancel()` for barge-in (REQ-4 — cancels in-flight synthesis, drops
 * pending audio, no further callbacks after it returns).
 */
export interface ITtsProvider {
  /**
   * Start a synthesis stream for one agent turn. Text arrives via `feed()`;
   * the provider decides when a unit is speakable (sentence boundary) and
   * synthesizes it immediately — audio starts flowing before the turn ends.
   */
  speak(callbacks: TtsStreamCallbacks): void;
  /** Feed incremental assistant text (deltas). Safe to call repeatedly. */
  feed(text: string): void;
  /** Signal: no more text this turn — flush and drain remaining audio. */
  endOfText(): void;
  /**
   * PoC 2026-10-31: synthesize whatever text is buffered NOW, without ending
   * the turn. The loop calls it when the model stops to run a tool, so the
   * preface ("voy a mirarlo") sounds while the tool works instead of waiting
   * in the provider's buffer for the text that follows the tool result.
   * Optional: providers that synthesize eagerly need nothing.
   */
  flush?(): void;
  /** Barge-in: cancel everything in flight (REQ-4). Idempotent. */
  cancel(): void;
  /** Whether a stream is active (speak() called, not yet ended/cancelled). */
  isSpeaking(): boolean;
}
