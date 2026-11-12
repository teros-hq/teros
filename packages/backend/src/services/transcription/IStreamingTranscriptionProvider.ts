/**
 * Streaming Transcription Provider Interface
 *
 * Voice Mode v2 — F1a (spec v1.1.0 REQ-1): streaming speech-to-text for the
 * native voice loop. Distinct from `ITranscriptionProvider` (batch, file-based,
 * used for voice-message transcription) — this interface is push-based: audio
 * chunks in, interim/final transcripts out, over a long-lived connection.
 *
 * Providers (Deepgram Nova-3, …) implement this; the voice loop
 * (`handlers/voice-loop.ts`) consumes it and never talks to a vendor SDK
 * directly, so STT stays a swappable commodity (research §6, NFR-5).
 */

/** Callbacks the voice loop registers on the streaming provider. */
export interface StreamingTranscriptionCallbacks {
  /**
   * Interim (partial) transcript for the utterance currently being spoken.
   * Emitted as it evolves — the loop forwards it to the frontend as a
   * `transcript { partial: true }` frame.
   */
  onInterim: (text: string) => void;
  /**
   * The user STARTED speaking (VAD, REQ-4 barge-in) — the first interim of a
   * new utterance, before any transcript is stable. Optional: providers
   * without utterance tracking never call it (the loop falls back to the
   * client `interrupt` frame). This is the earliest speech signal the
   * backend can see — barge-in must not wait for the final transcript.
   */
  onSpeechStart?: () => void;
  /**
   * FINAL transcript of a complete utterance (endpointing boundary — the
   * user stopped speaking). This is what enters the pipeline: persistence
   * (source:'voice') + the Teros agent turn. One call per utterance.
   */
  onFinal: (text: string) => void;
  /** Provider-level failure (connection dropped, auth rejected, …). */
  onError: (error: Error) => void;
  /** The underlying connection closed (after close() or a fatal error). */
  onClose?: () => void;
}

/** Options for the streaming session. */
export interface StreamingTranscriptionConfig {
  /**
   * ISO-639-1 language code. Default 'es' (matches the platform default in
   * .secrets/system/transcription.json → languageCode).
   */
  languageCode?: string;
  /**
   * Endpointing: ms of silence that close an utterance. Lower = snappier
   * turn-taking, higher = fewer cut-offs. Default 300 (spec §Fase 1 risk:
   * Spanish turn-taking latency, tunable without redeploy via constructor).
   */
  endpointingMs?: number;
  /** Custom vocabulary terms (domain names, acronyms) for accuracy biasing. */
  vocabulary?: string[] | null;
}

/**
 * Streaming speech-to-text provider. One instance per voice session
 * connection; the voice loop owns the lifecycle (connect → sendAudio* → close).
 */
export interface IStreamingTranscriptionProvider {
  /** Open the streaming connection. Resolves when ready to receive audio. */
  connect(callbacks: StreamingTranscriptionCallbacks, config?: StreamingTranscriptionConfig): Promise<void>;
  /** Push a base64-encoded audio chunk (PCM from the client mic). */
  sendAudio(base64Audio: string): void;
  /** Close the stream (sends the provider's CloseStream message if any). */
  close(): void;
  /** Whether the underlying connection is open. */
  isOpen(): boolean;
}
