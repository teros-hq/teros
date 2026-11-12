import { describe, it, expect, mock, afterEach } from "bun:test"
import { TranscriptionProviderFactory } from "../../src/services/transcription/TranscriptionProviderFactory"
import type { SecretsManager } from "../../src/secrets/secrets-manager"

// Tests below replace globalThis.fetch; put the real one back so later test
// files in the same process don't inherit the mock.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * Tests for custom vocabulary support in STT providers.
 *
 * Vocabulary terms (domain-specific names, product names, acronyms) are
 * passed to STT providers to improve transcription accuracy:
 * - Whisper: vocabulary → `prompt` form field (comma-joined string)
 * - ElevenLabs Scribe: vocabulary → repeated `keyterms` form fields
 */
describe("Custom vocabulary for STT", () => {
  describe("TranscriptionProviderFactory.getDefaultVocabulary", () => {
    it("returns the vocabulary array when configured", () => {
      const sm = {
        system: mock(() => ({
          provider: "elevenlabs",
          vocabulary: ["Teros", "MCA", "Scribe"],
        })),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toEqual(["Teros", "MCA", "Scribe"])
    })

    it("returns null when vocabulary is not set in config", () => {
      const sm = {
        system: mock(() => ({ provider: "elevenlabs" })),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toBeNull()
    })

    it("returns null when transcription config does not exist", () => {
      const sm = {
        system: mock(() => null),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toBeNull()
    })

    it("filters out empty and non-string entries", () => {
      const sm = {
        system: mock(() => ({
          provider: "elevenlabs",
          vocabulary: ["Teros", "", "  ", 42, null, "Scribe"],
        })),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toEqual(["Teros", "Scribe"])
    })

    it("returns null when vocabulary array is empty after filtering", () => {
      const sm = {
        system: mock(() => ({
          provider: "elevenlabs",
          vocabulary: ["", "  ", ""],
        })),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toBeNull()
    })

    it("returns null when vocabulary is explicitly null", () => {
      const sm = {
        system: mock(() => ({ provider: "elevenlabs", vocabulary: null })),
      } as unknown as SecretsManager

      const vocab = TranscriptionProviderFactory.getDefaultVocabulary(sm)
      expect(vocab).toBeNull()
    })
  })

  describe("WhisperTranscriptionProvider with vocabulary", () => {
    it("passes vocabulary as prompt (comma-joined) to the Whisper API", async () => {
      const { WhisperTranscriptionProvider } = await import(
        "../../src/services/transcription/WhisperTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: "The new Teros MCA is ready.",
              language: "en",
              duration: 2.0,
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new WhisperTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-vocab-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath, {
          vocabulary: ["Teros", "MCA", "Scribe"],
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        // Whisper receives vocabulary as a comma-joined prompt string
        expect(body.get("prompt")).toBe("Teros, MCA, Scribe")
        expect(body.get("model")).toBe("whisper-1")
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("does NOT pass prompt when vocabulary is not provided", async () => {
      const { WhisperTranscriptionProvider } = await import(
        "../../src/services/transcription/WhisperTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: "No vocabulary here.",
              language: "en",
              duration: 1.0,
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new WhisperTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-no-vocab-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        expect(body.get("prompt")).toBeNull()
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("does NOT pass prompt when vocabulary is an empty array", async () => {
      const { WhisperTranscriptionProvider } = await import(
        "../../src/services/transcription/WhisperTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: "Empty vocab.",
              language: "en",
              duration: 1.0,
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new WhisperTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-empty-vocab-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath, { vocabulary: [] })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        expect(body.get("prompt")).toBeNull()
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })
  })

  describe("ElevenLabsTranscriptionProvider with vocabulary", () => {
    it("passes vocabulary as keyterms (individual entries) to the Scribe API", async () => {
      const { ElevenLabsTranscriptionProvider } = await import(
        "../../src/services/transcription/ElevenLabsTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              language_code: "en",
              language_probability: 0.99,
              text: "The new Teros MCA is ready.",
              words: [],
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new ElevenLabsTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-scribe-vocab-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath, {
          vocabulary: ["Teros", "MCA", "Scribe"],
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        // Scribe receives each vocabulary term as a separate keyterms entry
        expect(body.getAll("keyterms")).toEqual(["Teros", "MCA", "Scribe"])
        expect(body.get("model_id")).toBe("scribe_v1")
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("does NOT pass keyterms when vocabulary is not provided", async () => {
      const { ElevenLabsTranscriptionProvider } = await import(
        "../../src/services/transcription/ElevenLabsTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              language_code: "en",
              language_probability: 0.99,
              text: "No vocabulary here.",
              words: [],
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new ElevenLabsTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-scribe-no-vocab-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        expect(body.getAll("keyterms")).toEqual([])
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("filters out terms longer than 50 characters", async () => {
      const { ElevenLabsTranscriptionProvider } = await import(
        "../../src/services/transcription/ElevenLabsTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              language_code: "en",
              language_probability: 0.99,
              text: "Filtered.",
              words: [],
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new ElevenLabsTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-scribe-filter-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      const longTerm = "A".repeat(51) // 51 chars — exceeds Scribe's 50-char limit

      try {
        await provider.transcribe(tmpPath, {
          vocabulary: ["Teros", longTerm, "Scribe"],
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        // Only valid terms pass through
        expect(body.getAll("keyterms")).toEqual(["Teros", "Scribe"])
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("trims whitespace from keyterms", async () => {
      const { ElevenLabsTranscriptionProvider } = await import(
        "../../src/services/transcription/ElevenLabsTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              language_code: "en",
              language_probability: 0.99,
              text: "Trimmed.",
              words: [],
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new ElevenLabsTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-scribe-trim-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath, {
          vocabulary: ["  Teros  ", " MCA "],
        })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        expect(body.getAll("keyterms")).toEqual(["Teros", "MCA"])
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })
  })
})
