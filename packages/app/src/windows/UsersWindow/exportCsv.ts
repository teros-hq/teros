/**
 * exportCsv — the billing CSV export, split into a PURE string builder and a
 * single web-guarded download call.
 *
 * `buildBillingCsv` is deterministic (no DOM, no `Date.now`) so it is unit
 * tested for the exact bytes. `downloadCsv` is the ONLY place in the Users panel
 * that touches `document`/`Blob`; it no-ops off web (native/SSR) instead of
 * crashing, so the escape hatch is confined and guarded (PR4).
 */

export interface BillingCsvRow {
  userId: string
  email: string
  planName: string
  effectivePrice: number
  periodStart: string
  periodEnd: string
  billingStatus: string
  billingNotes: string
}

const CSV_HEADER = [
  "user_id",
  "email",
  "plan",
  "price_effective",
  "period_start",
  "period_end",
  "billing_status",
  "billing_notes",
] as const

/** RFC-4180 cell: wrap in quotes, escape embedded quotes by doubling them. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/** ISO date-time → `YYYY-MM-DD` (first 10 chars); empty stays empty. */
function isoDate(value: string): string {
  return value ? value.slice(0, 10) : ""
}

/** Build the billing CSV for one user — pure, deterministic, DOM-free. */
export function buildBillingCsv(row: BillingCsvRow): string {
  const dataRow = [
    row.userId,
    row.email,
    row.planName,
    String(row.effectivePrice),
    isoDate(row.periodStart),
    isoDate(row.periodEnd),
    row.billingStatus,
    row.billingNotes,
  ]
  return [CSV_HEADER, dataRow]
    .map((cells) => cells.map((c) => csvCell(String(c))).join(","))
    .join("\n")
}

/**
 * Trigger a browser download of `csv` under `filename`. Web only: off web (no
 * `document`) it silently no-ops rather than throwing, so callers stay
 * cross-native. This is the SINGLE guarded `document`/`Blob` use in the panel.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === "undefined") return
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
