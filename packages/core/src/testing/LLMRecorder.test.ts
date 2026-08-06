/**
 * Unit — MockLLMAdapter throw-on-miss (TER-563).
 *
 * El fallback "mismo número de mensajes" devolvía la cassette EQUIVOCADA en
 * silencio cuando el hash del input no coincidía (verde engañoso: un turno
 * reproducía otra cassette). Ahora un miss en replay LANZA con el hash.
 */

import { describe, expect, it } from "bun:test"
import { hashInput, MockLLMAdapter, type Recording } from "./LLMRecorder"

function msg(role: string, text: string) {
  return { info: { role }, parts: [{ type: "text", text }] }
}

function recordingFor(messages: unknown[]): Recording {
  return {
    version: "1.0",
    calls: [
      {
        // biome-ignore lint/suspicious/noExplicitAny: input mínimo del boundary
        inputHash: hashInput({ messages, tools: [] } as any),
        input: { messages: messages as unknown[] },
        events: [{ type: "text", chunk: "ok" }],
        // biome-ignore lint/suspicious/noExplicitAny: response mínima del fixture
        response: { content: "ok" } as any,
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    metadata: { createdAt: "2026-01-01T00:00:00.000Z" },
  }
}

describe("MockLLMAdapter — throw-on-miss (TER-563)", () => {
  it("lanza ante un input sin cassette aunque tenga el MISMO nº de mensajes (no devuelve la equivocada)", async () => {
    // Cassette grabada para un input de 3 mensajes.
    const recording = recordingFor([msg("user", "a"), msg("assistant", "b"), msg("user", "c")])
    const mock = new MockLLMAdapter(recording)

    // Input DISTINTO, también con 3 mensajes: el viejo fallback por nº de
    // mensajes habría devuelto la cassette equivocada; ahora debe lanzar.
    const other = { messages: [msg("user", "X"), msg("assistant", "Y"), msg("user", "Z")], tools: [] }
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: input mínimo del boundary
      mock.streamMessage(other as any),
    ).rejects.toThrow(/No recorded LLM response for input hash/)
  })
})
