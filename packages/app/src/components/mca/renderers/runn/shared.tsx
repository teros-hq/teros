/**
 * Runn — constants, types, helpers, and a compose-only `RunnToolShell`.
 *
 * Zero components are defined here (renderer design system, TER-281). The
 * global primitives (`ToolCallCard`, `ResourceCard`, `EntityRow`, `IconTile`,
 * `IconChip`, `KeyValueGrid`, `DualEntity`, `Badge`, …) cover every Runn UI
 * case through props. What lives here:
 *
 *  - Constants: official Runn brand palette + logo url.
 *  - Light types mirroring the curated backend shapes (all fields optional
 *    except `id`, since the backend whitelists vary by tool).
 *  - Generic helpers (`unwrap`, `unwrapList`, `formatDate`, `fmtMinutes`,
 *    `personName`, `diffFields`, status helpers).
 *  - `RunnToolShell` — compose-only wrapper over `ToolCallCard` that pre-fills
 *    `iconUri={RUNN_ICON}` and the description label.
 */

import type React from "react"
import { Text, XStack } from "tamagui"
import { Badge, type KeyValueRow, ToolCallCard, useColors, useMcaTheme } from "../../primitives"
import type { ToolCallRendererProps } from "../../types"

// ============================================================================
// Constants — official Runn brand
// ============================================================================

export const RUNN_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/runn-icon.png`

/**
 * Runn's official brand palette, taken from the colour logo SVG
 * (blue→purple gradient symbol + navy wordmark). NOT Tailwind defaults.
 * Used as the accent for brand tiles/chips where the backend gives no
 * per-entity colour (Runn resources carry no colour field).
 */
export const RUNN_BRAND = {
  blue: "#2d74ee",
  purple: "#b044ee",
  navy: "#253382",
} as const

/**
 * Runn renderer palette. Combines the official Runn brand colors (kept
 * hardcoded per brand guidelines) with the Design System theme-adaptive surface
 * tokens from `useColors()`. The web scrollbar color switches between dark and
 * light variants so it remains visible on both card backgrounds.
 */
export function useRunnColors() {
  const c = useColors()
  const theme = useMcaTheme()
  const isDark = theme === "dark"

  return {
    ...c,
    theme,
    isDark,
    brand: RUNN_BRAND,
    // Scrollbar thumb must invert between themes to stay visible against the card surface.
    scrollbarColor: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)",
  }
}

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useRunnColors()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
export function useScrollStyle(maxHeight: number): any {
  const { scrollbarColor } = useRunnColors()
  return {
    maxHeight,
    scrollbarWidth: "thin",
    scrollbarColor: `${scrollbarColor} transparent`,
  }
}

// ============================================================================
// Light types mirroring curated backend shapes (whitelist-tolerant)
// ============================================================================

export interface RunnTag {
  id: number
  name: string
}

export interface RunnProject {
  id: number
  name?: string
  clientId?: number
  teamId?: number | null
  isArchived?: boolean
  isConfirmed?: boolean
  isTemplate?: boolean
  pricingModel?: string
  rateType?: string
  budget?: number | null
  expensesBudget?: number | null
  tags?: RunnTag[]
  createdAt?: string
  updatedAt?: string
}

export interface RunnPerson {
  id: number
  firstName?: string
  lastName?: string
  email?: string | null
  isArchived?: boolean
  teamId?: number | null
  tags?: RunnTag[]
  holidaysGroupId?: number | null
  createdAt?: string
  updatedAt?: string
}

export interface RunnPlaceholder {
  id: number
  firstName?: string
  lastName?: string
  isArchived?: boolean
  tags?: RunnTag[]
  createdAt?: string
  updatedAt?: string
}

export interface RunnAssignment {
  id: number
  personId?: number
  projectId?: number
  roleId?: number
  startDate?: string
  endDate?: string
  minutesPerDay?: number
  isBillable?: boolean
  isPlaceholder?: boolean
  isNonWorkingDay?: boolean
  note?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface RunnActual {
  id: number
  date?: string
  personId?: number
  projectId?: number
  roleId?: number
  billableMinutes?: number
  nonbillableMinutes?: number
  billableNote?: string | null
  nonbillableNote?: string | null
  createdAt?: string
  updatedAt?: string
}

export interface RunnClient {
  id: number
  name?: string
  website?: string | null
  isArchived?: boolean
  createdAt?: string
  updatedAt?: string
}

export interface RunnRole {
  id: number
  name?: string | null
  isArchived?: boolean
  defaultHourCost?: number
  standardRate?: number
  createdAt?: string
  updatedAt?: string
}

export interface RunnTeam {
  id: number
  name?: string
  createdAt?: string
  updatedAt?: string
}

export interface RunnSkill {
  id: number
  name?: string
  createdAt?: string
  updatedAt?: string
}

export interface RunnProjectTotals {
  id: number
  billableMinutes?: number
  nonBillableMinutes?: number
  totalMinutes?: number
}

// ============================================================================
// Tool labels
// ============================================================================

/**
 * Imperative verb phrases — `ToolCallCard` composes the tense automatically
 * (`Will list… / Listing… / Listed / Failed to list / Wants to list`) via
 * `inferTenseForms`. MUST be verb-first (NOT nouns like "Projects", which would
 * conjugate to "Projectsed"). The verb is matched against the irregular/doubling
 * sets in `primitives/tense.ts`.
 */
export const TOOL_LABELS: Record<string, string> = {
  "runn-list-projects": "List projects",
  "runn-get-project": "Get project",
  "runn-create-project": "Create project",
  "runn-update-project": "Update project",
  "runn-list-people": "List people",
  "runn-get-person": "Get person",
  "runn-create-person": "Create person",
  "runn-list-placeholders": "List placeholders",
  "runn-create-placeholder": "Create placeholder",
  "runn-list-assignments": "List assignments",
  "runn-create-assignment": "Create assignment",
  "runn-delete-assignment": "Delete assignment",
  "runn-list-actuals": "List timesheets",
  "runn-create-actual": "Log time",
  "runn-list-clients": "List clients",
  "runn-create-client": "Create client",
  "runn-list-roles": "List roles",
  "runn-list-teams": "List teams",
  "runn-list-skills": "List skills",
  "runn-project-totals": "Get project totals",
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split("_")
  return parts[parts.length - 1] || toolName
}

function humanize(name: string): string {
  const cleaned = name.startsWith("runn-") ? name.slice("runn-".length) : name
  const joined = cleaned.replace(/-/g, " ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName)
  return TOOL_LABELS[short] ?? humanize(short)
}

// ============================================================================
// Generic helpers (local — do not pollute the primitives barrel)
// ============================================================================

/** Human name for a person/placeholder, falling back to `Person #id`. */
export function personName(
  p: { firstName?: string; lastName?: string; id: number },
  kind: "Person" | "Placeholder" = "Person",
): string {
  const n = [p.firstName, p.lastName].filter(Boolean).join(" ").trim()
  return n || `${kind} #${p.id}`
}

/** Format a minute count as a compact `Xh Ym` / `Xh` / `Ym` string. */
export function fmtMinutes(min?: number | null): string {
  if (min == null || Number.isNaN(min)) return "—"
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "—"
  // Business dates are already YYYY-MM-DD; timestamps get sliced to the day.
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toISOString().slice(0, 10)
  } catch {
    return iso
  }
}

/**
 * Defensive: if the backend ever wraps the data in the legacy
 * `{ content, structuredContent }` envelope, reach through to the inner
 * payload. The production path is plain data, but tolerating both is the
 * TER-369 lesson (a shape change should never blank the renderer).
 */
function deref(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "structuredContent" in (parsed as object)
  ) {
    return (parsed as { structuredContent: unknown }).structuredContent
  }
  return parsed
}

/** Extracts an object tolerant to `{ <key>: {...} }` or a direct object. */
export function unwrap<T extends object>(
  parsed: unknown,
  wrapperKey: string,
  identifierField: keyof T,
): T | null {
  const d = deref(parsed)
  if (!d || typeof d !== "object") return null
  const obj = d as Record<string, unknown>
  const wrapped = obj[wrapperKey]
  if (wrapped && typeof wrapped === "object" && (identifierField as string) in wrapped) {
    return wrapped as T
  }
  if ((identifierField as string) in obj) return obj as T
  return null
}

/** Extracts a list tolerant to `{ items: [...], nextCursor, total }` or a raw array. */
export function unwrapList<T>(parsed: unknown): {
  items: T[]
  nextCursor?: string | null
  total?: number
  hasMore?: boolean
} {
  const d = deref(parsed)
  if (!d) return { items: [] }
  if (Array.isArray(d)) return { items: d as T[] }
  if (typeof d !== "object") return { items: [] }
  const obj = d as Record<string, unknown>
  const list = obj.items
  const items = Array.isArray(list) ? (list as T[]) : []
  const nextCursor = typeof obj.nextCursor === "string" ? (obj.nextCursor as string) : null
  const total = typeof obj.total === "number" ? (obj.total as number) : undefined
  const hasMore = typeof obj.hasMore === "boolean" ? (obj.hasMore as boolean) : undefined
  return { items, nextCursor, total, hasMore }
}

/** Derives KeyValueGrid rows from update input args (skips empty values). */
export function diffFields(
  input: Record<string, unknown> | undefined,
  keys: string[],
): KeyValueRow[] {
  if (!input) return []
  const out: KeyValueRow[] = []
  for (const k of keys) {
    const v = input[k]
    if (v === undefined || v === null || v === "") continue
    const str =
      typeof v === "string"
        ? v.length > 80
          ? `${v.slice(0, 80)}…`
          : v
        : Array.isArray(v)
          ? `(${v.length} item${v.length !== 1 ? "s" : ""})`
          : typeof v === "object"
            ? "(updated)"
            : String(v)
    out.push({ key: k, value: str })
  }
  return out
}

interface ListFooterProps {
  total?: number
  nextCursor?: string | null
}

/**
 * Compact list footer ("N shown · more") shown under a paginated list. Tiny
 * JSX component (like `statusBadge`) — not a styled component. Uses
 * `useColors()` so it must be rendered, not called as a plain function.
 */
export function ListFooter({ total, nextCursor }: ListFooterProps): React.ReactNode {
  const c = useColors()
  if (typeof total !== "number" && !nextCursor) return null
  return (
    <XStack gap={6} justifyContent="flex-end" paddingHorizontal={4} paddingTop={2}>
      {typeof total === "number" && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          {total} shown
        </Text>
      )}
      {nextCursor && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          · more
        </Text>
      )}
    </XStack>
  )
}

export function toolStatusForPrimitive(
  status: ToolCallRendererProps["status"],
): Exclude<ToolCallRendererProps["status"], "pending"> {
  if (status === "pending") return "running"
  return status
}

export function statusBadge(status: ToolCallRendererProps["status"]): React.ReactNode {
  if (status === "completed") return <Badge text="done" variant="success" />
  if (status === "failed") return <Badge text="failed" variant="error" />
  if (status === "pending_permission") return <Badge text="awaiting" variant="warning" />
  if (status === "running" || status === "pending") return <Badge text="running" variant="info" />
  return null
}

// ============================================================================
// RunnToolShell — compose-only wrapper (no duplication)
// ============================================================================

interface RunnToolShellProps {
  toolName: string
  status: ToolCallRendererProps["status"]
  description?: string
  children?: React.ReactNode
  defaultExpanded?: boolean
  badge?: React.ReactNode
}

/**
 * Pre-fills `iconUri={RUNN_ICON}`, the description label and the status badge
 * on top of the global `<ToolCallCard/>`. No new styling — the global
 * primitive does the visual work; this wrapper just saves boilerplate.
 */
export function RunnToolShell({
  toolName,
  status,
  description,
  children,
  defaultExpanded,
  badge,
}: RunnToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      verb={getToolLabel(toolName)}
      iconUri={RUNN_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  )
}
