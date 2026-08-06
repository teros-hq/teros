/**
 * usersModel — pure, testable helpers for the admin Users panel.
 *
 * No JSX and no client here: colour decisions, plan/quota derivations and date
 * formatting live as pure functions so the table cells (UsersWindowContent) and
 * the tests share ONE source of truth. Colours derive from the monitoring
 * `tokens` (never hardcoded hex) so the theme work touches one file.
 */

import type { BadgeVariant } from "../../components/mca/primitives"
import { tokens } from "../../components/monitoring/colors"
import type { BillingInfo, UsageFilter, UserRole, UserStatus } from "../../services/AdminApi"

// ─── Plan badge ───────────────────────────────────────────────────────────────

/**
 * Single source for the plan chip colour. Keyed by the real plan ids/names
 * (billing seed) case-insensitively; the `plan_` prefix is stripped so both a
 * planId (`plan_pro`) and a planName (`Pro`) resolve. Unknown → neutral tertiary
 * so the active plan ALWAYS shows a chip, even after the catalogue adds a tier.
 */
const PLAN_COLORS: Record<string, string> = {
  starter: tokens.textTertiary,
  essential: tokens.textTertiary,
  basic: tokens.textTertiary,
  free: tokens.textTertiary,
  growth: tokens.accent,
  pro: tokens.success,
  ultra: tokens.warning,
  max: tokens.warning,
  infinity: tokens.warning,
  unlimited: tokens.warning,
  enterprise: tokens.warning,
  team: tokens.success,
}

export function planBadge(planId: string, planName?: string): { label: string; color: string } {
  const label = planName ?? planId
  const candidates = [
    planName?.toLowerCase(),
    planId?.toLowerCase(),
    planId?.toLowerCase().replace(/^plan[_-]/, ""),
  ]
  for (const key of candidates) {
    if (key && key in PLAN_COLORS) return { label, color: PLAN_COLORS[key] }
  }
  return { label, color: tokens.textTertiary }
}

// ─── Hours / quota usage ──────────────────────────────────────────────────────

/** "48 / 70" style hours: integers stay integers, fractions show one decimal. */
function fmtHours(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export interface HoursUsage {
  used: number
  limit: number | null
  pct: number | null
  unmetered: boolean
  /** "48 / 70" (metered), "∞" (unmetered), or "—" (no billing). */
  label: string
}

export function hoursUsage(billing: BillingInfo | null): HoursUsage {
  if (!billing) return { used: 0, limit: null, pct: null, unmetered: false, label: "—" }
  const unmetered = billing.unmetered === true
  const used = billing.agentHoursUsed ?? 0
  const limit = billing.effectiveLimit ?? null
  const pct = unmetered ? null : (billing.pct ?? (limit && limit > 0 ? used / limit : null))
  const label = unmetered
    ? "∞"
    : limit != null
      ? `${fmtHours(used)} / ${fmtHours(limit)}`
      : fmtHours(used)
  return { used, limit, pct, unmetered, label }
}

/**
 * Cell colour for the hours value: red at/over the limit, amber from 80%, muted
 * secondary below; unmetered or no-billing (pct null) stays neutral tertiary.
 */
export function hoursColor(pct: number | null, unmetered: boolean): string {
  if (unmetered || pct == null) return tokens.textTertiary
  if (pct >= 1) return tokens.error
  if (pct >= 0.8) return tokens.warning
  return tokens.textSecondary
}

// ─── Status + role meta (colour + i18n key) ───────────────────────────────────

/** User status → dot colour + i18n label key. (The monitoring `statusMeta` does
 *  not model user statuses — it would paint `suspended` green.) */
export function userStatusMeta(status: UserStatus): { color: string; labelKey: string } {
  switch (status) {
    case "active":
      return { color: tokens.success, labelKey: "windows.usersPanel.status.active" }
    case "suspended":
      return { color: tokens.error, labelKey: "windows.usersPanel.status.suspended" }
    case "pending_verification":
      return { color: tokens.warning, labelKey: "windows.usersPanel.status.pending" }
  }
}

/** Role → Badge variant. `super` is highlighted (warning) so it stands out. */
export function roleBadgeVariant(role: UserRole): BadgeVariant {
  switch (role) {
    case "super":
      return "warning"
    case "admin":
      return "info"
    default:
      return "gray"
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────────

/** "15 Jun 2026" — the collapsed-row date format (kept from UserCard). */
export function formatDate(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return "—"
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" })
}

/** Compact relative time: "—" (missing), "now", "5m", "3h", "2d", else a date. */
export function formatRelative(iso?: string): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const diff = Date.now() - t
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  if (hours < 24) return `${hours}h`
  if (days < 30) return `${days}d`
  return formatDate(iso)
}

/** Epoch ms for sorting the "last access" column; missing/invalid sort oldest. */
export function lastAccessSortValue(iso?: string): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

// ─── Numeric formatting (detail KPIs) ─────────────────────────────────────────

/** USD currency, max 2 decimals — the detail "total cost" KPI (kept from UserCard). */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost)) return "—"
  return cost.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  })
}

/** Compact integer (e.g. "12.3K", "4.1M") — the detail "tokens" KPI. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

// ─── Cuota (usage) filter options ─────────────────────────────────────────────

/** Options for the Cuota dropdown; `labelKey` resolves via i18n in the view. */
export const USAGE_FILTER_OPTIONS: { key: UsageFilter | "all"; labelKey: string }[] = [
  { key: "all", labelKey: "windows.usersPanel.usage.all" },
  { key: "near", labelKey: "windows.usersPanel.usage.near" },
  { key: "exhausted", labelKey: "windows.usersPanel.usage.exhausted" },
  { key: "has_boost", labelKey: "windows.usersPanel.usage.hasBoost" },
  { key: "unmetered", labelKey: "windows.usersPanel.usage.unmetered" },
  { key: "no_sub", labelKey: "windows.usersPanel.usage.noSub" },
]
