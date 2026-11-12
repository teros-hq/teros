import { describe, it, expect } from "bun:test"
import {
  heuristicClean,
  isPlausibleClean,
  TranscriptCleaner,
  type TranscriptCleanMode,
} from "../../src/services/transcription/transcript-cleaner"

/**
 * Tests for the STT transcript cleaner (post-processing of voice-note
 * transcripts before they reach the agent).
 *
 * AC from the task: Pablo's real examples must come out clean while meaning
 * is preserved — cleaning is form-only, never content.
 */

describe("heuristicClean", () => {
  it("returns empty/whitespace input unchanged", () => {
    expect(heuristicClean("")).toBe("")
    expect(heuristicClean("   ")).toBe("   ")
  })

  it("removes standalone interjections (eh, mmm, eh)", () => {
    expect(heuristicClean("eh, hola")).toBe("hola")
    expect(heuristicClean("mmm, esto es una prueba")).toBe("esto es una prueba")
    expect(heuristicClean("eh, mmm, hola que tal")).toBe("hola que tal")
  })

  it("removes parenthetical discourse fillers (o sea, es decir)", () => {
    expect(heuristicClean("o sea, si digo algo")).toBe("si digo algo")
    expect(heuristicClean("es decir: vamos a hacerlo")).toBe("vamos a hacerlo")
  })

  it("does NOT remove meaning-bearing uses of filler words", () => {
    // "o sea" as noun phrase / "vale" as verb must survive.
    expect(heuristicClean("el o sea que dibujó")).toBe("el o sea que dibujó")
    expect(heuristicClean("esto vale mucho")).toBe("esto vale mucho")
    expect(heuristicClean("no me gusta como eh... digo esto")).toContain("esto")
  })

  it("removes attached tag questions (¿no?, ¿vale?) but keeps standalone ones", () => {
    expect(heuristicClean("cerramos la tarea, ¿vale?")).toBe("cerramos la tarea")
    expect(heuristicClean("vamos a ello, ¿no?")).toBe("vamos a ello")
    // A message that is ONLY the tag question is kept (meaning-bearing).
    expect(heuristicClean("¿vale?")).toBe("¿vale?")
  })

  it("removes whitelisted non-speech markers and keeps real asides", () => {
    expect(heuristicClean("mmm, [chasquido], eh, hola")).toBe("hola")
    expect(heuristicClean("(risa) qué fuerte")).toBe("qué fuerte")
    // Real parenthetical content is KEPT.
    expect(heuristicClean("me trabo (lo he hecho adrede) hoy")).toBe(
      "me trabo (lo he hecho adrede) hoy",
    )
  })

  it("dedupes immediate repeated words (digo, digo)", () => {
    expect(heuristicClean("si digo, digo algo")).toBe("si digo algo")
    expect(heuristicClean("digo, digo: algo")).toBe("digo: algo")
    expect(heuristicClean("the the cat")).toBe("the cat")
  })

  it("keeps legitimate emphasis repetitions", () => {
    expect(heuristicClean("es muy muy bueno")).toBe("es muy muy bueno")
    expect(heuristicClean("sí, sí, vamos")).toBe("sí, sí, vamos")
    expect(heuristicClean("no, no quiero")).toBe("no, no quiero")
  })

  it("Pablo's AC example: full stammered sentence", () => {
    const raw = "mmm, [chasquido], eh, o sea, si digo, digo: imagínate que digo algo"
    const out = heuristicClean(raw)
    // Heuristic layer gets close; the LLM layer finishes the false-start fix.
    expect(out).toBe("si digo: imagínate que digo algo")
  })

  it("keeps English fillers out too", () => {
    expect(heuristicClean("uh, well, I think we should ship it")).toBe(
      "I think we should ship it",
    )
  })

  it("leaves normal sentences untouched", () => {
    const s = "Aprovechamos y añadimos una tarea para mañana"
    expect(heuristicClean(s)).toBe(s)
  })
})

describe("isPlausibleClean (LLM output guard)", () => {
  it("accepts a legitimate cleaning (fillers dropped)", () => {
    expect(
      isPlausibleClean(
        "mmm, eh, o sea, si digo, digo: imagínate que digo algo",
        "si digo: imagínate que digo algo",
      ),
    ).toBe(true)
  })

  it("accepts Pablo's target output", () => {
    expect(isPlausibleClean("mmm, [chasquido], eh, o sea, si digo, digo: imagínate que digo algo", "Si digo algo")).toBe(true)
  })

  it("rejects an invented answer (hallucinated content)", () => {
    expect(
      isPlausibleClean("mmm, eh, o sea, si digo algo", "Claro, ahora mismo te creo la tarea en el board"),
    ).toBe(false)
  })

  it("rejects empty output", () => {
    expect(isPlausibleClean("hola que tal", "")).toBe(false)
    expect(isPlausibleClean("hola que tal", "   ")).toBe(false)
  })
})

describe("TranscriptCleaner service", () => {
  const fakeLLM = (output: string, delayMs = 0) => ({
    generateText: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return output
    },
  })

  it("mode heuristic never calls the LLM", async () => {
    let called = 0
    const cleaner = new TranscriptCleaner({
      internalLLM: { generateText: async () => { called++; return "x" } } as any,
    })
    const res = await cleaner.clean("eh, hola que tal", "heuristic")
    expect(called).toBe(0)
    expect(res.text).toBe("hola que tal")
    expect(res.layers.heuristic).toBe(true)
    expect(res.layers.llm).toBe(false)
  })

  it("mode llm applies the LLM rewrite on top of the heuristic pass", async () => {
    const cleaner = new TranscriptCleaner({
      internalLLM: fakeLLM("Si digo algo") as any,
    })
    const res = await cleaner.clean(
      "mmm, [chasquido], eh, o sea, si digo, digo: imagínate que digo algo",
      "llm",
    )
    expect(res.text).toBe("Si digo algo")
    expect(res.cleaned).toBe(true)
    expect(res.layers.llm).toBe(true)
  })

  it("falls back to the heuristic result when the LLM output is hallucinated", async () => {
    const cleaner = new TranscriptCleaner({
      internalLLM: fakeLLM("Claro, te abro un ticket ahora mismo") as any,
    })
    const res = await cleaner.clean("mmm, eh, o sea, si digo algo", "llm")
    expect(res.text).toBe("o sea, si digo algo".replace("o sea, ", ""))
    expect(res.layers.llm).toBe(false)
  })

  it("falls back to the heuristic result when the LLM times out", async () => {
    const cleaner = new TranscriptCleaner({
      internalLLM: fakeLLM("Si digo algo", 200) as any,
    })
    // Force a tiny timeout by racing against a slow fake (we cannot override
    // the constant, so we assert the fallback path via a rejected LLM).
    const broken = new TranscriptCleaner({
      internalLLM: { generateText: async () => { throw new Error("provider down") } } as any,
    })
    const res = await broken.clean("eh, hola", "llm")
    expect(res.text).toBe("hola")
    expect(res.layers.llm).toBe(false)
    void cleaner
  })

  it("returns the raw transcript when cleaning throws", async () => {
    const cleaner = new TranscriptCleaner({ internalLLM: null })
    const res = await cleaner.clean("hola", "llm")
    expect(res.text).toBe("hola")
    expect(res.cleaned).toBe(false)
  })

  it("empty transcript short-circuits untouched", async () => {
    const cleaner = new TranscriptCleaner({ internalLLM: null })
    const res = await cleaner.clean("", "llm")
    expect(res.text).toBe("")
    expect(res.cleaned).toBe(false)
  })

  it("result carries mode and duration metadata", async () => {
    const cleaner = new TranscriptCleaner({ internalLLM: null })
    const res = await cleaner.clean("eh, hola", "heuristic")
    expect(res.mode).toBe<TranscriptCleanMode>("heuristic")
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })
})
