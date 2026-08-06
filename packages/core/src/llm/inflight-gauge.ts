/**
 * Process-level in-flight LLM stream counter, keyed by upstream provider
 * (TER-616/§2.1 saturation). Incremented when an adapter starts streaming and
 * decremented when it finishes (success or error). The backend `/metrics` route
 * reads the snapshot and exposes it as a gauge per `actualProvider`.
 *
 * Best-effort, single-process: this measures concurrency on THIS node, which is
 * the client-side saturation signal serverless providers don't expose.
 */

const inflight = new Map<string, number>()

export function incInflight(provider: string): void {
  inflight.set(provider, (inflight.get(provider) ?? 0) + 1)
}

export function decInflight(provider: string): void {
  const next = (inflight.get(provider) ?? 0) - 1
  if (next <= 0) inflight.delete(provider)
  else inflight.set(provider, next)
}

/** Current in-flight count per provider (copy; safe to iterate/serialize). */
export function getInflightSnapshot(): Record<string, number> {
  return Object.fromEntries(inflight)
}

/** Total in-flight across all providers. */
export function getInflightTotal(): number {
  let total = 0
  for (const n of inflight.values()) total += n
  return total
}
