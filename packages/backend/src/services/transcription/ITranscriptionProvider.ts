/**
 * Transcription Provider Interface
 *
 * Provider-agnostic interface for speech-to-text services.
 * All providers (OpenAI Whisper, ElevenLabs Scribe, etc.) implement this.
 */

/**
 * Options for transcription
 */
export interface TranscriptionOptions {
  /**
   * ISO-639-1 or ISO-639-3 language code (e.g., 'es', 'en', 'cat')
   * If not provided, the provider will attempt to auto-detect
   */
  languageCode?: string;

  /**
   * Enable speaker diarization (identify different speakers)
   * Not all providers support this
   */
  diarize?: boolean;

  /**
   * Include timestamps in the response
   */
  includeTimestamps?: boolean;
}

/**
 * Word-level timing information
 */
export interface TranscriptionWord {
  text: string;
  start?: number; // Start time in seconds
  end?: number; // End time in seconds
  speaker?: string; // Speaker ID (if diarization enabled)
}

/**
 * Result from transcription
 */
export interface TranscriptionResult {
  /** The transcribed text */
  text: string;

  /** Detected or specified language code */
  language?: string;

  /** Confidence of language detection (0-1) */
  languageConfidence?: number;

  /** Audio duration in seconds */
  duration?: number;

  /** Word-level details (if available) */
  words?: TranscriptionWord[];

  /** Provider-specific metadata */
  metadata?: Record<string, any>;
}

/**
 * Provider information
 */
export interface TranscriptionProviderInfo {
  name: string;
  model: string;
  supportsLanguageDetection: boolean;
  supportsDiarization: boolean;
  supportsTimestamps: boolean;
}

/**
 * Transcription Provider Interface
 *
 * All speech-to-text providers must implement this interface.
 */
export interface ITranscriptionProvider {
  /**
   * Transcribe an audio file
   *
   * @param filePath - Path to the audio file
   * @param options - Transcription options
   * @returns Transcription result
   */
  transcribe(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult>;

  /**
   * Get provider information
   */
  getProviderInfo(): TranscriptionProviderInfo;
}
