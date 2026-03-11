/**
 * OpenAI Whisper Transcription Provider
 *
 * Uses OpenAI's Whisper API for speech-to-text transcription.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  ITranscriptionProvider,
  TranscriptionOptions,
  TranscriptionProviderInfo,
  TranscriptionResult,
} from './ITranscriptionProvider';

export interface WhisperProviderConfig {
  apiKey: string;
  model?: string; // Default: 'whisper-1'
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

export class WhisperTranscriptionProvider implements ITranscriptionProvider {
  private apiKey: string;
  private model: string;

  constructor(config: WhisperProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'whisper-1';
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
    formData.append('model', this.model);
    formData.append('response_format', 'verbose_json');

    // Add language if specified
    if (options?.languageCode) {
      formData.append('language', options.languageCode);
    }

    // Request word-level timestamps if requested
    if (options?.includeTimestamps) {
      formData.append('timestamp_granularities[]', 'word');
    }

    // Call OpenAI Whisper API
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Whisper API error: ${response.status} - ${error}`);
    }

    const result = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
      words?: Array<{
        word: string;
        start: number;
        end: number;
      }>;
    };

    return {
      text: result.text,
      language: result.language,
      duration: result.duration,
      words: result.words?.map((w) => ({
        text: w.word,
        start: w.start,
        end: w.end,
      })),
      metadata: {
        provider: 'whisper',
        model: this.model,
      },
    };
  }

  getProviderInfo(): TranscriptionProviderInfo {
    return {
      name: 'OpenAI Whisper',
      model: this.model,
      supportsLanguageDetection: true,
      supportsDiarization: false,
      supportsTimestamps: true,
    };
  }
}
