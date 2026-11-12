/**
 * Transcription Log Service
 *
 * Records every speech-to-text transcription to a MongoDB `transcription_logs`
 * collection for debugging, analytics, and cost tracking.
 *
 * Each log entry captures:
 * - Provider + model used (whisper, elevenlabs)
 * - Detected or forced language
 * - Audio file path, duration, and size
 * - Transcribed text and character count
 * - Estimated cost in USD
 * - Success/failure status
 * - Context: userId, channelId, messageId, agentId
 *
 * Logging is best-effort: a failure to write a log entry never blocks
 * or fails the transcription itself.
 */

import type { Collection, Db } from "mongodb"
import { COLLECTIONS, ensureCollectionIndexes } from "../../db"
import * as fs from "fs"
import type { TranscriptionProviderType } from "./TranscriptionProviderFactory"

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface TranscriptionLogEntry {
  /** MongoDB auto-generated ObjectId */
  _id?: import("mongodb").ObjectId

  /** When the transcription was performed */
  timestamp: Date

  /** Provider used: 'whisper' | 'elevenlabs' */
  provider: TranscriptionProviderType

  /** Model identifier (e.g. 'whisper-1', 'scribe_v1') */
  model: string

  /** Language detected by the provider (ISO-639 code), or null if not reported */
  language: string | null

  /** Confidence of language detection (0–1), when available */
  languageConfidence?: number

  /** Language code forced via config, or null if auto-detection was used */
  forcedLanguageCode: string | null

  /** Path to the audio file on disk at transcription time */
  audioPath: string

  /** Audio duration in seconds, when reported by the provider */
  audioDurationSeconds?: number

  /** Audio file size in bytes */
  audioSizeBytes?: number

  /** The transcribed text */
  transcriptionText: string

  /** Character count of the transcription (for quick metrics) */
  transcriptionCharCount: number

  /** Estimated cost in USD, or null when duration is unavailable */
  cost: number | null

  /** Whether the transcription succeeded */
  success: boolean

  /** Error message when success = false */
  errorMessage?: string

  /** Time taken to transcribe, in milliseconds */
  durationMs?: number

  // --- Context (denormalized for queryability) ---

  userId?: string
  channelId?: string
  messageId?: string
  agentId?: string
}

// ---------------------------------------------------------------------------
// COST TABLE
// ---------------------------------------------------------------------------

/**
 * Cost per minute of audio, in USD, by provider.
 *
 * - Whisper:  $0.006/min  (OpenAI pricing as of 2025)
 * - ElevenLabs Scribe: $0.40/hour ≈ $0.00667/min
 *
 * These are list prices before any volume discounts.
 */
const PROVIDER_COST_PER_MINUTE: Record<TranscriptionProviderType, number> = {
  whisper: 0.006,
  elevenlabs: 0.00667,
}

// ---------------------------------------------------------------------------
// SERVICE
// ---------------------------------------------------------------------------

export class TranscriptionLogService {
  private collection: Collection<TranscriptionLogEntry>

  constructor(private db: Db) {
    this.collection = db.collection<TranscriptionLogEntry>("transcription_logs")
  }

  /**
   * Create indexes for the transcription_logs collection.
   * Safe to call multiple times — createIndex is idempotent.
   */
  async initializeIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    // No TTL — logs are kept indefinitely for debugging and analytics.
    await ensureCollectionIndexes(this.collection, COLLECTIONS.transcriptionLogs)
  }

  /**
   * Insert a transcription log entry.
   *
   * This method is best-effort: if the insert fails (e.g. MongoDB
   * connectivity issue), the error is logged to console but NOT
   * re-thrown. Transcription must never fail because logging failed.
   */
  async log(entry: Omit<TranscriptionLogEntry, "_id">): Promise<void> {
    try {
      await this.collection.insertOne(entry as TranscriptionLogEntry)
    } catch (err) {
      // Best-effort — never block transcription
      console.error(
        "[TranscriptionLogService] Failed to write transcription log:",
        err,
      )
    }
  }

  /**
   * Compute the estimated cost of a transcription based on provider
   * and audio duration.
   *
   * @returns Cost in USD, or null when duration is unavailable
   */
  static computeCost(
    provider: TranscriptionProviderType,
    durationSeconds?: number,
  ): number | null {
    if (!durationSeconds || durationSeconds <= 0) return null
    const costPerMinute = PROVIDER_COST_PER_MINUTE[provider] ?? 0
    // Round to 4 decimal places to avoid floating-point noise
    return Math.round(((durationSeconds / 60) * costPerMinute) * 10000) / 10000
  }

  /**
   * Get the file size of an audio file, if it exists.
   * Returns undefined if the file cannot be stat'd.
   */
  static getFileSize(filePath: string): number | undefined {
    try {
      const stat = fs.statSync(filePath)
      return stat.size
    } catch {
      return undefined
    }
  }
}
