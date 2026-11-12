import { describe, it, expect, mock, beforeEach } from "bun:test"
import { TranscriptionLogService } from "../../src/services/transcription/TranscriptionLogService"
import type { TranscriptionLogEntry } from "../../src/services/transcription/TranscriptionLogService"
import type { Db, Collection, InsertOneResult } from "mongodb"

/**
 * Tests for TranscriptionLogService.
 *
 * This service writes to the `transcription_logs` MongoDB collection.
 * Tests cover:
 * - Successful insert (all fields persisted correctly)
 * - Insert failure (best-effort: error caught, never re-thrown)
 * - Cost computation per provider (Whisper, ElevenLabs)
 * - Cost computation edge cases (no duration, zero duration, unknown provider)
 * - getFileSize for existing and non-existent files
 * - initializeIndexes creates the expected indexes (no TTL)
 */
describe("TranscriptionLogService", () => {
  // ---------------------------------------------------------------------------
  // MOCK FACTORY
  // ---------------------------------------------------------------------------

  function createMockCollection() {
    const insertOneMock = mock(
      (entry: TranscriptionLogEntry): Promise<InsertOneResult<TranscriptionLogEntry>> =>
        Promise.resolve({
          acknowledged: true,
          insertedId: { toString: () => "mock-id" } as any,
        }),
    )
    const createIndexMock = mock((_spec: any, _opts?: any) => Promise.resolve("index-created"))

    const collection = {
      insertOne: insertOneMock,
      createIndex: createIndexMock,
    } as unknown as Collection<TranscriptionLogEntry>

    return { collection, insertOneMock, createIndexMock }
  }

  function createMockDb(collection: Collection<TranscriptionLogEntry>): Db {
    const db = {
      collection: mock((_name: string) => collection),
    } as unknown as Db
    return db
  }

  // ---------------------------------------------------------------------------
  // log() — successful insert
  // ---------------------------------------------------------------------------

  describe("log()", () => {
    let service: TranscriptionLogService
    let insertOneMock: ReturnType<typeof mock>

    beforeEach(() => {
      const { collection, insertOneMock: iom } = createMockCollection()
      insertOneMock = iom
      const db = createMockDb(collection)
      service = new TranscriptionLogService(db)
    })

    it("inserts a log entry with all fields on success", async () => {
      const entry: Omit<TranscriptionLogEntry, "_id"> = {
        timestamp: new Date("2026-08-28T12:00:00Z"),
        provider: "whisper",
        model: "whisper-1",
        language: "es",
        languageConfidence: 0.98,
        forcedLanguageCode: "es",
        audioPath: "/uploads/user_123/audio.mp3",
        audioDurationSeconds: 5.5,
        audioSizeBytes: 102400,
        transcriptionText: "Hola, esto es una prueba.",
        transcriptionCharCount: 24,
        cost: 0.0006,
        success: true,
        durationMs: 1200,
        userId: "user_123",
        channelId: "ch_abc",
        messageId: "msg_xyz",
        agentId: "agent_001",
      }

      await service.log(entry)

      expect(insertOneMock).toHaveBeenCalledTimes(1)
      const inserted = insertOneMock.mock.calls[0][0] as TranscriptionLogEntry
      expect(inserted.provider).toBe("whisper")
      expect(inserted.model).toBe("whisper-1")
      expect(inserted.language).toBe("es")
      expect(inserted.languageConfidence).toBe(0.98)
      expect(inserted.forcedLanguageCode).toBe("es")
      expect(inserted.audioPath).toBe("/uploads/user_123/audio.mp3")
      expect(inserted.audioDurationSeconds).toBe(5.5)
      expect(inserted.audioSizeBytes).toBe(102400)
      expect(inserted.transcriptionText).toBe("Hola, esto es una prueba.")
      expect(inserted.transcriptionCharCount).toBe(24)
      expect(inserted.cost).toBe(0.0006)
      expect(inserted.success).toBe(true)
      expect(inserted.durationMs).toBe(1200)
      expect(inserted.userId).toBe("user_123")
      expect(inserted.channelId).toBe("ch_abc")
      expect(inserted.messageId).toBe("msg_xyz")
      expect(inserted.agentId).toBe("agent_001")
    })

    it("inserts a failure log entry with errorMessage and success=false", async () => {
      const entry: Omit<TranscriptionLogEntry, "_id"> = {
        timestamp: new Date("2026-08-28T12:00:00Z"),
        provider: "elevenlabs",
        model: "scribe_v1",
        language: null,
        forcedLanguageCode: null,
        audioPath: "/uploads/user_123/audio.webm",
        audioSizeBytes: 51200,
        transcriptionText: "",
        transcriptionCharCount: 0,
        cost: null,
        success: false,
        errorMessage: "Connection refused",
        durationMs: 500,
        userId: "user_123",
      }

      await service.log(entry)

      expect(insertOneMock).toHaveBeenCalledTimes(1)
      const inserted = insertOneMock.mock.calls[0][0] as TranscriptionLogEntry
      expect(inserted.success).toBe(false)
      expect(inserted.errorMessage).toBe("Connection refused")
      expect(inserted.language).toBeNull()
      expect(inserted.cost).toBeNull()
      expect(inserted.transcriptionText).toBe("")
    })

    it("does NOT re-throw when insertOne fails (best-effort logging)", async () => {
      const failingInsertOne = mock((_entry: TranscriptionLogEntry) =>
        Promise.reject(new Error("MongoDB connection lost")),
      )
      const collection = {
        insertOne: failingInsertOne,
        createIndex: mock((_spec: any, _opts?: any) => Promise.resolve("index-created")),
      } as unknown as Collection<TranscriptionLogEntry>
      const db = createMockDb(collection)
      service = new TranscriptionLogService(db)

      const errorSpy = mock()
      const originalConsoleError = console.error
      console.error = errorSpy as any

      try {
        // Should not throw — logging is best-effort
        await service.log({
          timestamp: new Date(),
          provider: "whisper",
          model: "whisper-1",
          language: "en",
          forcedLanguageCode: null,
          audioPath: "/tmp/audio.mp3",
          transcriptionText: "test",
          transcriptionCharCount: 4,
          cost: null,
          success: true,
        })

        expect(failingInsertOne).toHaveBeenCalledTimes(1)
        // The error should have been logged to console.error
        expect(errorSpy).toHaveBeenCalledTimes(1)
      } finally {
        console.error = originalConsoleError
      }
    })
  })

  // ---------------------------------------------------------------------------
  // computeCost() — static method
  // ---------------------------------------------------------------------------

  describe("computeCost()", () => {
    it("computes Whisper cost correctly ($0.006/min)", () => {
      // 60 seconds = 1 minute → $0.006
      const cost = TranscriptionLogService.computeCost("whisper", 60)
      expect(cost).toBe(0.006)
    })

    it("computes ElevenLabs cost correctly ($0.00667/min)", () => {
      // 60 seconds = 1 minute → $0.0067 (rounded to 4 decimal places)
      const cost = TranscriptionLogService.computeCost("elevenlabs", 60)
      expect(cost).toBe(0.0067)
    })

    it("computes cost for partial minutes (30 seconds)", () => {
      // 30 seconds = 0.5 min → 0.5 * 0.006 = 0.003
      const cost = TranscriptionLogService.computeCost("whisper", 30)
      expect(cost).toBe(0.003)
    })

    it("returns null when duration is undefined", () => {
      const cost = TranscriptionLogService.computeCost("whisper", undefined)
      expect(cost).toBeNull()
    })

    it("returns null when duration is zero", () => {
      const cost = TranscriptionLogService.computeCost("whisper", 0)
      expect(cost).toBeNull()
    })

    it("returns null when duration is negative", () => {
      const cost = TranscriptionLogService.computeCost("whisper", -5)
      expect(cost).toBeNull()
    })

    it("rounds to 4 decimal places to avoid floating-point noise", () => {
      // 10 seconds = 0.1667 min → 0.1667 * 0.006 = 0.001 (rounded)
      const cost = TranscriptionLogService.computeCost("whisper", 10)
      expect(cost).toBe(0.001)
    })

    it("computes cost for longer audio (10 minutes)", () => {
      // 600 seconds = 10 min → 10 * 0.006 = 0.06
      const cost = TranscriptionLogService.computeCost("whisper", 600)
      expect(cost).toBe(0.06)
    })
  })

  // ---------------------------------------------------------------------------
  // getFileSize() — static method
  // ---------------------------------------------------------------------------

  describe("getFileSize()", () => {
    it("returns the file size for an existing file", async () => {
      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-log-size-${Date.now()}.bin`
      const content = Buffer.from("hello-world-12345")
      await fs.writeFile(tmpPath, content)

      try {
        const size = TranscriptionLogService.getFileSize(tmpPath)
        expect(size).toBe(content.length)
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("returns undefined for a non-existent file", () => {
      const size = TranscriptionLogService.getFileSize("/tmp/does-not-exist-xyz123.mp3")
      expect(size).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // initializeIndexes() — no TTL
  // ---------------------------------------------------------------------------

  describe("initializeIndexes()", () => {
    it("creates 4 indexes and does NOT create a TTL index", async () => {
      const { collection, createIndexMock } = createMockCollection()
      const db = createMockDb(collection)
      const service = new TranscriptionLogService(db)

      await service.initializeIndexes()

      // Should have been called exactly 4 times (no TTL index)
      expect(createIndexMock).toHaveBeenCalledTimes(4)

      // Verify the index specs — none should have expireAfterSeconds
      const calls = createIndexMock.mock.calls
      const allSpecs = calls.map((c) => c[0])
      const allOpts = calls.map((c) => c[1])

      // Check the 4 expected indexes
      expect(allSpecs).toContainEqual({ timestamp: -1 })
      expect(allSpecs).toContainEqual({ userId: 1, timestamp: -1 })
      expect(allSpecs).toContainEqual({ provider: 1, timestamp: -1 })
      expect(allSpecs).toContainEqual({ channelId: 1, timestamp: -1 })

      // No index should have expireAfterSeconds option
      for (const opts of allOpts) {
        expect(opts?.expireAfterSeconds).toBeUndefined()
      }
    })
  })
})
