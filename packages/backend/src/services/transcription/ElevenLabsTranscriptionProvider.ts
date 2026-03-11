/**
 * ElevenLabs Scribe Transcription Provider
 *
 * Uses ElevenLabs' Scribe API for speech-to-text transcription.
 * Scribe offers high accuracy with support for 99+ languages,
 * speaker diarization, and word-level timestamps.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ITranscriptionProvider,
  TranscriptionOptions,
  TranscriptionProviderInfo,
  TranscriptionResult,
  TranscriptionWord,
} from './ITranscriptionProvider';

export interface ElevenLabsProviderConfig {
  apiKey: string;
  model?: string; // Default: 'scribe_v1'
}

/**
 * Get MIME type from file extension
 */
function getMimeTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(1);
  const extToMime: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
    aac: 'audio/aac',
    flac: 'audio/flac',
  };
  return extToMime[ext] || 'application/octet-stream';
}

/**
 * ElevenLabs Scribe API response types
 */
interface ScribeWord {
  text: string;
  start: number | null;
  end: number | null;
  type: 'word' | 'spacing' | 'audio_event';
  speaker_id?: string | null;
}

interface ScribeResponse {
  language_code: string;
  language_probability: number;
  text: string;
  words: ScribeWord[];
}

export class ElevenLabsTranscriptionProvider implements ITranscriptionProvider {
  private apiKey: string;
  private model: string;

  constructor(config: ElevenLabsProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'scribe_v1';
  }

  async transcribe(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
    // Read the file
    const fileBuffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);

    // Create form data for the API
    const formData = new FormData();

    const file = new File([fileBuffer], filename, {
      type: getMimeTypeFromExtension(filename),
    });

    formData.append('file', file);
    formData.append('model_id', this.model);

    // Add language if specified (ISO-639-1 or ISO-639-3)
    if (options?.languageCode) {
      formData.append('language_code', options.languageCode);
    }

    // Enable diarization if requested
    if (options?.diarize) {
      formData.append('diarize', 'true');
    }

    // Set timestamp granularity
    if (options?.includeTimestamps) {
      formData.append('timestamps_granularity', 'word');
    } else {
      formData.append('timestamps_granularity', 'none');
    }

    // Call ElevenLabs Scribe API
    const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ElevenLabs Scribe API error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as ScribeResponse;

    // Convert words to our format, filtering out spacing and audio events
    const words: TranscriptionWord[] = result.words
      .filter((w) => w.type === 'word')
      .map((w) => ({
        text: w.text,
        start: w.start ?? undefined,
        end: w.end ?? undefined,
        speaker: w.speaker_id ?? undefined,
      }));

    return {
      text: result.text,
      language: result.language_code,
      languageConfidence: result.language_probability,
      words: words.length > 0 ? words : undefined,
      metadata: {
        provider: 'elevenlabs',
        model: this.model,
      },
    };
  }

  getProviderInfo(): TranscriptionProviderInfo {
    return {
      name: 'ElevenLabs Scribe',
      model: this.model,
      supportsLanguageDetection: true,
      supportsDiarization: true,
      supportsTimestamps: true,
    };
  }
}
