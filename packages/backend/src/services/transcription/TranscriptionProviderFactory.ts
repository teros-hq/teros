/**
 * Transcription Provider Factory
 *
 * Creates transcription provider instances based on configuration.
 * API keys are resolved from SecretsManager (.secrets/system/).
 *
 * Supported providers:
 * - 'whisper': OpenAI Whisper API (requires .secrets/system/openai.json)
 * - 'elevenlabs': ElevenLabs Scribe API (requires .secrets/system/elevenlabs.json)
 */

import type { SecretsManager } from "../../secrets/secrets-manager"
import { ElevenLabsTranscriptionProvider } from "./ElevenLabsTranscriptionProvider"
import type { ITranscriptionProvider } from "./ITranscriptionProvider"
import { WhisperTranscriptionProvider } from "./WhisperTranscriptionProvider"

export type TranscriptionProviderType = "whisper" | "elevenlabs"

export interface TranscriptionConfig {
  provider: TranscriptionProviderType
  whisper?: {
    apiKey?: string
    model?: string // Default: 'whisper-1'
  }
  elevenlabs?: {
    apiKey?: string
    model?: string // Default: 'scribe_v1'
  }
}

/**
 * Resolve OpenAI API key from SecretsManager
 */
function resolveOpenAIApiKey(
  secretsManager: SecretsManager,
  config?: TranscriptionConfig["whisper"],
): string {
  // 1. Explicit API key in config (for tests)
  if (config?.apiKey) {
    return config.apiKey
  }

  // 2. SecretsManager: .secrets/system/openai.json
  const openaiSecret = secretsManager.system("openai")
  if (openaiSecret?.apiKey) {
    return openaiSecret.apiKey
  }

  throw new Error(
    "No OpenAI API key available for Whisper transcription.\n" +
      "Configure it in .secrets/system/openai.json:\n" +
      '  { "apiKey": "sk-..." }',
  )
}

/**
 * Resolve ElevenLabs API key from SecretsManager
 */
function resolveElevenLabsApiKey(
  secretsManager: SecretsManager,
  config?: TranscriptionConfig["elevenlabs"],
): string {
  // 1. Explicit API key in config (for tests)
  if (config?.apiKey) {
    return config.apiKey
  }

  // 2. SecretsManager: .secrets/system/elevenlabs.json
  const elevenLabsSecret = secretsManager.system("elevenlabs")
  if (elevenLabsSecret?.apiKey) {
    return elevenLabsSecret.apiKey
  }

  throw new Error(
    "No ElevenLabs API key available for Scribe transcription.\n" +
      "Configure it in .secrets/system/elevenlabs.json:\n" +
      '  { "apiKey": "xi_..." }',
  )
}

/**
 * Factory for creating transcription providers
 *
 * @example
 * ```typescript
 * // Using Whisper (default)
 * const provider = TranscriptionProviderFactory.create(secretsManager, {
 *   provider: 'whisper',
 * });
 *
 * // Using ElevenLabs Scribe
 * const provider = TranscriptionProviderFactory.create(secretsManager, {
 *   provider: 'elevenlabs',
 * });
 *
 * // Transcribe audio
 * const result = await provider.transcribe('/path/to/audio.mp3', {
 *   languageCode: 'es',  // Optional: force Spanish
 * });
 * ```
 */
export class TranscriptionProviderFactory {
  /**
   * Create a transcription provider based on configuration.
   * API keys are resolved from SecretsManager.
   */
  static create(
    secretsManager: SecretsManager,
    config: TranscriptionConfig,
  ): ITranscriptionProvider {
    switch (config.provider) {
      case "whisper": {
        const apiKey = resolveOpenAIApiKey(secretsManager, config.whisper)
        return new WhisperTranscriptionProvider({
          apiKey,
          model: config.whisper?.model,
        })
      }

      case "elevenlabs": {
        const apiKey = resolveElevenLabsApiKey(secretsManager, config.elevenlabs)
        return new ElevenLabsTranscriptionProvider({
          apiKey,
          model: config.elevenlabs?.model,
        })
      }

      default:
        throw new Error(`Unknown transcription provider: ${config.provider}`)
    }
  }

  /**
   * Get the configured provider from .secrets/system/transcription.json.
   * The config is the single source of truth — no auto-detection, no fallbacks.
   * Throws if no provider is configured.
   */
  static getDefaultProvider(secretsManager: SecretsManager): TranscriptionProviderType {
    const transcriptionConfig = secretsManager.system("transcription")
    if (transcriptionConfig?.provider) {
      return transcriptionConfig.provider
    }

    throw new Error(
      "No transcription provider configured.\n" +
        'Set .secrets/system/transcription.json: { "provider": "elevenlabs" | "whisper" }',
    )
  }

  /**
   * Get the default language code from transcription config.
   * Reads from .secrets/system/transcription.json → languageCode.
   * When set (e.g. "es"), the transcription provider will be told to use
   * that language instead of auto-detecting — prevents Whisper from
   * misidentifying Spanish as Catalan/Galician/Portuguese.
   * Returns null when not configured (auto-detection mode).
   */
  static getDefaultLanguageCode(secretsManager: SecretsManager): string | null {
    const transcriptionConfig = secretsManager.system("transcription")
    if (transcriptionConfig?.languageCode) {
      return transcriptionConfig.languageCode
    }
    return null
  }

  /**
   * Get the default custom vocabulary from transcription config.
   * Reads from .secrets/system/transcription.json → vocabulary (string[]).
   * These are domain-specific terms (product names, acronyms, proper nouns)
   * that should be recognized correctly during transcription.
   *
   * For Whisper: joined into a comma-separated prompt string.
   * For ElevenLabs Scribe: passed as individual keyterms entries.
   *
   * Returns null when not configured (no vocabulary biasing).
   */
  static getDefaultVocabulary(secretsManager: SecretsManager): string[] | null {
    const transcriptionConfig = secretsManager.system("transcription")
    if (Array.isArray(transcriptionConfig?.vocabulary)) {
      const terms = transcriptionConfig.vocabulary.filter(
        (t: unknown): t is string => typeof t === "string" && t.trim().length > 0,
      )
      return terms.length > 0 ? terms : null
    }
    return null
  }
}
