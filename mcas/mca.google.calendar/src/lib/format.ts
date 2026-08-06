/**
 * Formatting helpers shared by handlers.
 *
 * Two domains:
 *  - RRULE → human-readable phrase ("Weekly on Mon, Wed, Fri") for the renderer.
 *  - ISO datetime helpers (computeDurationMinutes, normaliseStart/End).
 */

const FREQUENCY_LABELS: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
}

const DAY_LABELS: Record<string, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
}

/**
 * Convert one or more RRULE strings into a human phrase.
 * Best-effort — falls back to the raw rule if it cannot be parsed.
 */
export function describeRecurrence(recurrence: string[] | null | undefined): string | null {
  if (!recurrence || recurrence.length === 0) return null
  const phrases = recurrence.map(describeSingleRule).filter((p): p is string => Boolean(p))
  return phrases.length > 0 ? phrases.join("; ") : null
}

function describeSingleRule(rule: string): string | null {
  if (!rule.startsWith("RRULE:")) return rule
  const parts = rule.slice(6).split(";")
  const params = new Map<string, string>()
  for (const part of parts) {
    const [key, value] = part.split("=")
    if (key && value) params.set(key, value)
  }
  const freq = params.get("FREQ")
  if (!freq) return rule
  const label = FREQUENCY_LABELS[freq] ?? freq
  const interval = params.get("INTERVAL")
  const byDay = params.get("BYDAY")
  const count = params.get("COUNT")
  const until = params.get("UNTIL")

  const segments: string[] = [
    interval && interval !== "1" ? `Every ${interval} ${label.toLowerCase()}` : label,
  ]
  if (byDay) {
    const days = byDay.split(",").map((code) => DAY_LABELS[code] ?? code)
    segments.push(`on ${days.join(", ")}`)
  }
  if (count) segments.push(`for ${count} occurrences`)
  if (until) segments.push(`until ${until}`)
  return segments.join(" ")
}

/**
 * Compute duration of a busy slot in minutes (rounded).
 */
export function computeDurationMinutes(startISO: string, endISO: string): number {
  const start = new Date(startISO).getTime()
  const end = new Date(endISO).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0
  return Math.round((end - start) / 60_000)
}

/**
 * Normalise a Google API event time field (`{dateTime?, date?, timeZone?}`) into
 * a flat ISO string. All-day events expose `date` instead of `dateTime`.
 */
export function flattenEventTime(
  field: { dateTime?: string | null; date?: string | null } | null | undefined,
): string | null {
  if (!field) return null
  return field.dateTime ?? field.date ?? null
}
