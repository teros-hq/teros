/**
 * F5a benchmark — real TTFT (time-to-first-token) of the fast-leg candidates.
 *
 * NOT part of the test suite — a one-shot measurement script (acceptance
 * criterion #5 of task F5a). Run from the package root:
 *
 *   bun scripts/voice-fast-llm-benchmark.ts
 *
 * Measures, per candidate (model × reasoning_effort), 5 streaming calls with a
 * realistic ~2k-token voice context (the trimmed voice system prompt + an
 * 11-line conversation history + the spoken turn), and reports min/p50/p95/max
 * TTFT — the time from request start to the first content chunk on the stream.
 *
 * Uses the same upstream the platform uses: resolveTerosUpstream('fireworks', …)
 * with the system secret 'fireworks' — no new keys, exactly the production path.
 */

import { resolveTerosUpstream } from "../src/services/teros-upstream.js"
import { SecretsManager } from "../src/secrets/secrets-manager.js"

interface Candidate {
  label: string
  modelId: string
  modelString: string
  effort: string
}

const CANDIDATES: Candidate[] = [
  { label: "deepseek-v4p1-flash @ none", modelId: "teros-deepseek-v4p1-flash", modelString: "accounts/fireworks/models/deepseek-v4p1-flash", effort: "none" },
  { label: "glm-5p3-flash @ low", modelId: "teros-glm-5p3-flash", modelString: "accounts/fireworks/models/glm-5p3-flash", effort: "low" },
  { label: "kimi-k3-fast @ none", modelId: "teros-kimi-k3-fast", modelString: "accounts/fireworks/routers/kimi-k3-fast", effort: "none" },
]

const RUNS = 5

// ── Realistic ~2k-token voice context (F5a: trimmed prompt + 12-line history) ──

const VOICE_SYSTEM_PROMPT = `Eres Alice, la COO de Teros. Estás hablando POR VOZ con el usuario.

Reglas de la conversación hablada:
- Respuestas BREVES: 1-3 frases. Es una conversación hablada, no un informe.
- Nada de markdown (ni listas, ni **negritas**, ni código salvo que te lo pidan explícitamente).
- Tono natural y directo, como una colega al teléfono.
- Si no entiendes algo, pregunta corto. No parafrasees lo obvio.
- Si la tarea es larga o compleja, dilo en una frase y ofrece seguirla por texto.`

const history = (n: number) => {
  const lines: Array<{ role: string; content: string }> = []
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? "user" : "assistant"
    lines.push({
      role: side,
      content:
        side === "user"
          ? `Anotación ${i}: revisa el estado del despliegue de pre-producción y dime si el build de ayer pasó los tests de humo; si no, dime qué falló y quién lo tiene asignado ahora mismo.`
          : `Revisado. El build de ayer pasó los tests de humo en pre-producción: 220 verdes, 0 fallos. El único pendiente es el restart del backend, que no se ha ejecutado porque está pendiente de confirmación del usuario.`,
    })
  }
  return lines
}

const MESSAGES = [
  ...history(11),
  { role: "user", content: "Perfecto. Entonces dime una cosa: cuánto tardó el último turno de voz de punta a punta, y qué tramo se comió la mayor parte del tiempo?" },
]

const secrets = new SecretsManager("/opt/teros/.secrets")
await secrets.load()

async function measureTTFT(c: Candidate): Promise<number> {
  const upstream = resolveTerosUpstream("fireworks", { modelId: c.modelId, modelString: c.modelString }, secrets)
  if (!upstream) throw new Error(`no upstream for ${c.modelId}`)

  const body = {
    model: upstream.modelString,
    messages: [{ role: "system", content: VOICE_SYSTEM_PROMPT }, ...MESSAGES],
    stream: true,
    max_tokens: 200,
    reasoning_effort: c.effort,
  }

  const t0 = performance.now()
  const res = await fetch(`${upstream.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${upstream.apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  let ttft: number | null = null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") continue
      try {
        const ev = JSON.parse(payload)
        const delta = ev.choices?.[0]?.delta
        if (delta?.content && ttft === null) {
          ttft = performance.now() - t0
          // TTFT measured — release the connection.
          await reader.cancel().catch(() => {})
          return ttft
        }
      } catch {
        // partial JSON line — keep buffering
      }
    }
  }
  if (ttft === null) throw new Error("stream ended with no content chunk")
  return ttft
}

function pct(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

for (const c of CANDIDATES) {
  const samples: number[] = []
  let errors = 0
  for (let i = 0; i < RUNS; i++) {
    try {
      samples.push(await measureTTFT(c))
    } catch (err) {
      errors++
      console.error(`  [${c.label}] run ${i + 1} failed: ${(err as Error).message}`)
    }
  }
  const sorted = [...samples].sort((a, b) => a - b)
  if (sorted.length) {
    console.log(
      `${c.label.padEnd(28)} n=${sorted.length}${errors ? ` (+${errors} err)` : ""}  min=${Math.round(sorted[0])}ms  p50=${Math.round(pct(sorted, 50))}ms  p95=${Math.round(pct(sorted, 95))}ms  max=${Math.round(sorted[sorted.length - 1])}ms`,
    )
  } else {
    console.log(`${c.label.padEnd(28)} ALL RUNS FAILED (${errors})`)
  }
}

console.log("\n— voice-fast-llm TTFT benchmark done (F5a acceptance criterion)")
