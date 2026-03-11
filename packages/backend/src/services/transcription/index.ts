/**
 * Transcription Service
 *
 * Provider-agnostic speech-to-text transcription.
 * Supports OpenAI Whisper and ElevenLabs Scribe.
 */

export type { ElevenLabsProviderConfig } from './ElevenLabsTranscriptionProvider';
export { ElevenLabsTranscriptionProvider } from './ElevenLabsTranscriptionProvider';
// Types and interfaces
export type {
  ITranscriptionProvider,
  TranscriptionOptions,
  TranscriptionProviderInfo,
  TranscriptionResult,
  TranscriptionWord,
} from './ITranscriptionProvider';
// Factory
export {
  type TranscriptionConfig,
  TranscriptionProviderFactory,
  type TranscriptionProviderType,
} from './TranscriptionProviderFactory';
export type { WhisperProviderConfig } from './WhisperTranscriptionProvider';
// Providers
export { WhisperTranscriptionProvider } from './WhisperTranscriptionProvider';
