import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { TranscriptionProviderFactory } from "../../src/services/transcription/TranscriptionProviderFactory"
import type { SecretsManager } from "../../src/secrets/secrets-manager"

// Tests below replace globalThis.fetch; put the real one back so later test
// files in the same process don't inherit the mock.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/**
 * Tests for the transcription language fix.
 *
 * Bug: Whisper auto-detection frequently misidentified Spanish as
 * Catalan/Galician/Portuguese. The fix reads a `languageCode` from
 * the transcription config and passes it to the provider.
 */
describe("Transcription language fix", () => {
  describe("TranscriptionProviderFactory.getDefaultLanguageCode", () => {
    it("returns the languageCode when configured", () => {
      const sm = {
        system: mock(() => ({ provider: "whisper", languageCode: "es" })),
      } as unknown as SecretsManager

      const lang = TranscriptionProviderFactory.getDefaultLanguageCode(sm)
      expect(lang).toBe("es")
    })

    it("returns null when languageCode is not set in config", () => {
      const sm = {
        system: mock(() => ({ provider: "whisper" })),
      } as unknown as SecretsManager

      const lang = TranscriptionProviderFactory.getDefaultLanguageCode(sm)
      expect(lang).toBeNull()
    })

    it("returns null when transcription config does not exist", () => {
      const sm = {
        system: mock(() => null),
      } as unknown as SecretsManager

      const lang = TranscriptionProviderFactory.getDefaultLanguageCode(sm)
      expect(lang).toBeNull()
    })

    it("returns null when languageCode is explicitly null", () => {
      const sm = {
        system: mock(() => ({ provider: "whisper", languageCode: null })),
      } as unknown as SecretsManager

      const lang = TranscriptionProviderFactory.getDefaultLanguageCode(sm)
      expect(lang).toBeNull()
    })
  })

  describe("WhisperTranscriptionProvider with languageCode", () => {
    it("passes languageCode to the Whisper API when provided", async () => {
      const { WhisperTranscriptionProvider } = await import(
        "../../src/services/transcription/WhisperTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: "Hola, esto es una prueba.",
              language: "es",
              duration: 2.5,
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new WhisperTranscriptionProvider({
        apiKey: "test-key",
      })

      // Write a minimal fake audio file
      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        const result = await provider.transcribe(tmpPath, { languageCode: "es" })

        expect(result.text).toBe("Hola, esto es una prueba.")
        expect(result.language).toBe("es")

        // Verify the fetch call included the language in the form data
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        expect(body.get("language")).toBe("es")
        expect(body.get("model")).toBe("whisper-1")
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })

    it("does NOT pass language to the API when languageCode is not provided", async () => {
      const { WhisperTranscriptionProvider } = await import(
        "../../src/services/transcription/WhisperTranscriptionProvider"
      )

      const fetchMock = mock((_url: string, _opts: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              text: "Auto-detected text.",
              language: "es",
              duration: 1.0,
            }),
        } as Response),
      )
      globalThis.fetch = fetchMock as any

      const provider = new WhisperTranscriptionProvider({
        apiKey: "test-key",
      })

      const fs = await import("fs/promises")
      const tmpPath = `/tmp/test-audio-${Date.now()}.mp3`
      await fs.writeFile(tmpPath, Buffer.from("fake-audio"))

      try {
        await provider.transcribe(tmpPath)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const callArgs = fetchMock.mock.calls[0]
        const body = callArgs[1]?.body as FormData
        // language should NOT be in the form data when not specified
        expect(body.get("language")).toBeNull()
      } finally {
        await fs.unlink(tmpPath).catch(() => {})
      }
    })
  })
})
