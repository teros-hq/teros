#!/usr/bin/env node
// Health-polling para el deploy (TER-519).
//
// Sustituye el `sleep 15` + single-curl frágil de deploy-server.sh por un sondeo
// real contra el /health profundo (TER-418): el deploy solo continúa cuando el
// backend responde 200 + {status:'ok'}; si no levanta dentro del presupuesto de
// tiempo, este proceso sale != 0 y deploy-server.sh dispara el rollback.
//
// El falso negativo recurrente (incidente 2026-05-28, PR #122) venía de que el
// backend en fork-mode tarda unos segundos extra en cargar todas las MCAs/
// conexiones tras el restart; el `sleep 15` fijo lo medía demasiado pronto. Un
// loop con reintentos lo elimina sin enmascarar un deploy realmente roto: si el
// /health profundo devuelve 503 (Mongo caída) reintenta hasta el timeout y aborta.
//
// Sin dependencias (fetch global de Node 20+). La lógica pura está extraída para
// poder MORDERLA con bun:test (tests/unit/scripts/wait-for-health.test.ts).

import { fileURLToPath } from 'node:url'

/**
 * Decide si una respuesta de /health significa "backend listo".
 *
 * El /health profundo (TER-418) responde 200 + {status:'ok'} SOLO cuando Mongo
 * está viva, y 503 + {status:'degraded'} si una dep crítica cae. "Listo" exige
 * AMBOS: el código 200 Y status === 'ok'. Un 200 con un body inesperado (proxy
 * intermedio, página de error que devuelve 200, etc.) NO cuenta como listo.
 */
export function isHealthy(statusCode, body) {
  return statusCode === 200 && !!body && body.status === 'ok'
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sondea `url` hasta que isHealthy() o se agoten los intentos.
 *
 * Devuelve { ok, attempts, lastError }: ok=true en cuanto está listo (corta el
 * loop), attempts = nº de intentos consumidos. fetchImpl/sleepImpl/logImpl se
 * inyectan para testear sin red ni esperas reales.
 */
export async function pollHealth({
  url,
  attempts = 30,
  intervalMs = 2000,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  logImpl = () => {},
}) {
  let lastError = 'no attempt made'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url)
      let body = null
      try {
        body = await res.json()
      } catch {
        body = null
      }
      if (isHealthy(res.status, body)) {
        logImpl(`[health] ready on attempt ${attempt}/${attempts} (HTTP ${res.status})`)
        return { ok: true, attempts: attempt, lastError: '' }
      }
      lastError = `HTTP ${res.status}${body && body.status ? ` status=${body.status}` : ''}`
      logImpl(`[health] attempt ${attempt}/${attempts}: not ready — ${lastError}`)
    } catch (err) {
      lastError = err && err.message ? err.message : String(err)
      logImpl(`[health] attempt ${attempt}/${attempts}: unreachable — ${lastError}`)
    }
    // No dormir tras el último intento: el presupuesto ya se agotó.
    if (attempt < attempts) await sleepImpl(intervalMs)
  }
  return { ok: false, attempts, lastError }
}

// --- CLI ---
// Solo corre cuando se invoca directo (node scripts/wait-for-health.mjs <url> …),
// nunca cuando el test lo importa.
/**
 * Parsea argv. El intervalo se expresa en SEGUNDOS (lo natural para un operador
 * leyendo deploy-server.sh), convertido a ms internamente. Antes el arg era ms y
 * deploy-server.sh pasaba `2` queriendo decir 2s → polling de ~60ms y rollback
 * falso en cada deploy (TER-519). Extraído de main() para poder MORDERLO con test.
 */
export function parseCliArgs(argv) {
  const url = argv[2] ?? null
  const attempts = argv[3] ? Number(argv[3]) : 30
  const intervalSec = argv[4] ? Number(argv[4]) : 2
  return { url, attempts, intervalMs: intervalSec * 1000 }
}

async function main() {
  const { url, attempts, intervalMs } = parseCliArgs(process.argv)
  if (!url) {
    console.error('usage: node wait-for-health.mjs <url> [attempts] [intervalSec]')
    process.exit(2)
  }
  const result = await pollHealth({
    url,
    attempts,
    intervalMs,
    logImpl: (m) => console.log(m),
  })
  if (result.ok) {
    console.log(`[health] OK after ${result.attempts} attempt(s)`)
    process.exit(0)
  }
  console.error(`[health] FAILED after ${result.attempts} attempt(s) — last error: ${result.lastError}`)
  process.exit(1)
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  main()
}
