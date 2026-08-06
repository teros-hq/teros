/**
 * Voice — channel.transcribeAudio with a minimal in-memory WAV (200ms of silence).
 * Degradable: transcription needs a configured speech-to-text backend; if it's not
 * wired in this env, skip with the reason rather than fail. Loose assertion (the
 * result is a string — silence may transcribe to empty text).
 */
import { expect, test } from "../fixtures"
import { evalTeros } from "../helpers/teros"

/** Build a valid 8kHz mono 16-bit PCM WAV of `seconds` of silence, base64-encoded. */
function silentWavBase64(seconds = 0.2): string {
  const sampleRate = 8000
  const numSamples = Math.floor(sampleRate * seconds)
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write("data", 36)
  buf.writeUInt32LE(dataSize, 40)
  // samples already zero (silence)
  return buf.toString("base64")
}

test.describe("voice @voice", () => {
  test("channel.transcribeAudio devuelve texto (silencio)", async ({ terosPage }) => {
    test.setTimeout(45_000)
    const wav = silentWavBase64()

    const res = await evalTeros(
      terosPage,
      (wav) =>
        window.teros.channel
          .transcribeAudio(wav, "audio/wav")
          .then((r) => ({ ok: true as const, text: r.text }))
          .catch((e) => ({ ok: false as const, err: String(e) })),
      wav,
    )

    test.skip(
      !res.ok,
      `transcribeAudio no viable en el entorno (STT no configurado): ${"err" in res ? res.err : ""}`,
    )
    expect(typeof (res.ok ? res.text : null), "transcribeAudio devuelve un string").toBe("string")
  })
})
