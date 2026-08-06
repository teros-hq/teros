/**
 * Boundary validators + small helpers shared by Runn tool handlers.
 *
 * Runn v1 uses numeric integer ids (NOT uuids — that was v0). Business dates
 * are `YYYY-MM-DD`. We validate at the handler boundary what JSON Schema can't
 * express (real calendar dates, positive ids, non-negative minutes) so the
 * agent gets a precise error instead of an opaque 422 from Runn.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** A positive integer Runn id. Accepts the value as it arrives from JSON. */
export function validateId(id: unknown, label: string): number {
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error(
      `Invalid ${label}: expected a positive integer Runn id, got ${JSON.stringify(id)}`,
    )
  }
  return id
}

/** A `YYYY-MM-DD` business date that is also a real calendar date. */
export function validateDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: expected a date in YYYY-MM-DD format, got ${JSON.stringify(value)}`,
    )
  }
  const [year, month, day] = value.split("-").map(Number)
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error(`Invalid ${label}: "${value}" is not a real calendar date.`)
  }
  return value
}

/** A non-negative integer minute count. */
export function validateMinutes(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${label}: expected a non-negative integer number of minutes, got ${JSON.stringify(value)}`,
    )
  }
  return value
}

/** Assert `endDate >= startDate` (both already validated as YYYY-MM-DD). */
export function validateDateRange(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new Error(
      `Invalid date range: endDate "${endDate}" must be on or after startDate "${startDate}".`,
    )
  }
}

/** Trim a string arg, returning undefined for empty/whitespace/non-strings. */
export function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Require a non-empty string (after trim) for a mandatory field. */
export function validateNonEmptyString(value: unknown, label: string): string {
  const cleaned = cleanOptionalString(value)
  if (cleaned === undefined) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`)
  }
  return cleaned
}
