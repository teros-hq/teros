/**
 * Dead-letter NDJSON line parser (A1.6 / TER-675).
 *
 * The dead-letter writer serialises events with `JSON.stringify`, which turns
 * every `Date` into an ISO-8601 string (`appliedAt`, `payload.startedAt`,
 * `payload.endedAt`). Replaying with a plain `JSON.parse` reinserts those as
 * STRINGS: the TTL index (which only expires BSON `Date`) never fires, and the
 * dashboard/rollup/reconciler date-range `$match`es never match a string — the
 * recovered events are effectively invisible.
 *
 * This module is the symmetric inverse of the writer's `JSON.stringify`: a
 * strict ISO-8601 reviver rehydrates those fields back into `Date`. The regex is
 * deliberately strict (full `YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±HH:MM)`) so a random
 * id/string that isn't a timestamp is never coerced.
 */

import type { AgentUsageEvent } from "../types/database.js"

/** Strict ISO-8601 instant. Anchored, requires the `T`, seconds, and a zone. */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * JSON.parse reviver that turns strict ISO-8601 strings into `Date`. Anything
 * else passes through untouched. Exported for direct unit testing.
 */
export function deadLetterDateReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_8601_RE.test(value)) {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return new Date(ms)
  }
  return value
}

/**
 * Parse one dead-letter NDJSON line into an event with its `Date` fields
 * rehydrated — the exact shape the online applier writes, so TTL + date-range
 * queries behave identically to a live event.
 */
export function parseDeadLetterEvent(line: string): AgentUsageEvent {
  return JSON.parse(line, deadLetterDateReviver) as AgentUsageEvent
}
