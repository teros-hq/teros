// ============================================================================
// BOARD UTILITIES
// ============================================================================

import type { Board, BoardColumn, Task } from "../../store/boardStore"

export const COLUMN_COLORS: Record<string, string> = {
  // The OS prototype's column tints: grey · mint · amber · red · violet · green
  backlog: "#968FA7",
  todo: "#00D1A3",
  in_progress: "#F59E0B",
  blocked: "#EF4444",
  review: "#6F27FF",
  done: "#1CA24D",
}

export function getColumnColor(slug: string): string {
  return COLUMN_COLORS[slug] || "#968FA7"
}

// ============================================================================
// BLOCK STATUS — Traffic light (green / orange / red)
// ============================================================================

/**
 * Traffic-light status reflecting the state of a task's dependencies:
 *
 * - 'green'  → No dependencies, or all dependencies are done/archived (unblocked)
 * - 'orange' → All dependencies are in progress (in_progress, review, or running)
 * - 'red'    → At least one dependency hasn't started yet (backlog, todo, or blocked)
 * - 'circular' → Dependency cycle detected by the backend
 */
export type BlockStatus = "green" | "orange" | "red" | "circular"

export const BLOCK_STATUS_CONFIG: Record<
  BlockStatus,
  { color: string; bg: string; icon: string; label: string }
> = {
  green: { color: "#22C55E", bg: "rgba(34,197,94,0.15)", icon: "●", label: "Desbloqueada" },
  orange: {
    color: "#F97316",
    bg: "rgba(249,115,22,0.15)",
    icon: "●",
    label: "Dependencias en marcha",
  },
  red: {
    color: "#EF4444",
    bg: "rgba(239,68,68,0.15)",
    icon: "●",
    label: "Dependencias sin empezar",
  },
  circular: {
    color: "#F59E0B",
    bg: "rgba(245,158,11,0.15)",
    icon: "⚠",
    label: "Dependencia circular",
  },
}

/** Column slugs that count as "in progress" (dependency is being worked on) */
const IN_PROGRESS_SLUGS = new Set(["in_progress", "review"])

/** Column slugs that count as "not started" (dependency hasn't been picked up) */
const NOT_STARTED_SLUGS = new Set(["backlog", "todo", "blocked"])

/**
 * Determine the traffic-light status of a task based on its dependencies.
 *
 * Rules (evaluated in order):
 * 1. No dependencies → green (unblocked)
 * 2. Any dependency in a not-started column (backlog/todo/blocked) → red
 * 3. All dependencies are in progress (in_progress/review) or done/archived → orange
 *    (orange because at least one dep is still being worked on)
 * 4. All dependencies done/archived → green
 *
 * @param task       The task to evaluate
 * @param allTasks   All tasks on the board (to look up dependency states)
 * @param allColumns Board columns (to map columnId → slug). Optional for backwards compat.
 */
export function getBlockStatus(
  task: Task,
  allTasks: Task[],
  allColumns?: BoardColumn[],
): BlockStatus {
  if (!task.dependencies || task.dependencies.length === 0) {
    return "green"
  }

  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.taskId, t]))
  const colMap = allColumns
    ? new Map<string, BoardColumn>(allColumns.map((c) => [c.columnId, c]))
    : null

  let hasInProgress = false

  for (const depId of task.dependencies) {
    const dep = taskMap.get(depId)
    if (!dep) continue // unknown dep — treat as non-blocking

    // Archived deps are completed — skip
    if (dep.archived) continue

    // Determine the column slug of this dependency
    const slug = colMap?.get(dep.columnId)?.slug

    // If in a not-started column → red (at least one dep hasn't started)
    if (slug && NOT_STARTED_SLUGS.has(slug)) {
      return "red"
    }

    // If running or in an in-progress column → mark as in-progress
    if (dep.running || (slug && IN_PROGRESS_SLUGS.has(slug))) {
      hasInProgress = true
      continue
    }

    // If we can't determine the column and it's not archived, treat as not started
    if (!slug) {
      return "red"
    }
  }

  // If we got here, no dependency is in a not-started state.
  // If at least one is in progress → orange. Otherwise all done → green.
  return hasInProgress ? "orange" : "green"
}

// ============================================================================
// DEPENDENCY HIGHLIGHT
// ============================================================================

/**
 * The highlight state for a task when another task is hovered/selected.
 *
 * - 'will-unblock'   → this task depends on the hovered task AND completing
 *                      the hovered task would fully unblock it (no other pending deps).
 * - 'still-blocked'  → this task depends on the hovered task BUT has other
 *                      pending dependencies, so it would still be blocked.
 * - null             → no highlight (task does not depend on the hovered task).
 */
export type DependencyHighlight = "will-unblock" | "still-blocked" | null

/**
 * Given a hovered/selected task and all tasks on the board, compute the
 * highlight state for every other task.
 *
 * Returns a Map<taskId, DependencyHighlight> — only tasks that should be
 * highlighted will have a non-null value.
 */
export function computeDependencyHighlights(
  hoveredTaskId: string,
  allTasks: Task[],
): Map<string, DependencyHighlight> {
  const result = new Map<string, DependencyHighlight>()
  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.taskId, t]))

  for (const task of allTasks) {
    // Skip the hovered task itself
    if (task.taskId === hoveredTaskId) continue
    // Only care about tasks that list the hovered task as a dependency
    if (!task.dependencies || !task.dependencies.includes(hoveredTaskId)) continue

    // Count other pending dependencies (excluding the hovered task)
    const otherPendingDeps = task.dependencies.filter((depId) => {
      if (depId === hoveredTaskId) return false
      const dep = taskMap.get(depId)
      // If the dep exists and is not archived, it's still pending
      return dep ? !dep.archived : false
    })

    if (otherPendingDeps.length === 0) {
      result.set(task.taskId, "will-unblock")
    } else {
      result.set(task.taskId, "still-blocked")
    }
  }

  return result
}

export function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return "ahora"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  const years = Math.floor(months / 12)
  return `${years}y`
}

/**
 * Relative time in natural Spanish (compact: "hace 30m", "hace 2h").
 * Unit glued to the number, lowercase — matches the English branch (`2h ago`)
 * and the agent-hours chips (`2.3h`), so every duration in the board reads
 * as one family. Falls back to a compact date for older entries.
 */
export function timeAgoNatural(dateStr: string, locale: "en" | "es" = "en"): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const seconds = Math.floor((now - then) / 1000)

  if (locale === "es") {
    if (seconds < 60) return "ahora mismo"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `hace ${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `hace ${hours}h`
    const days = Math.floor(hours / 24)
    if (days === 1) return "ayer"
    if (days < 7) return `hace ${days}d`
    if (days < 30) return `hace ${Math.floor(days / 7)}sem`
    const d = new Date(dateStr)
    return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" })
  }

  // English (default)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return "yesterday"
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  const d = new Date(dateStr)
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" })
}

// ============================================================================
// BURNUP / BURNDOWN DATA
// ============================================================================

export interface BurnupPoint {
  date: string
  label: string
  timestamp: number
  cumulativeDone: number
  totalAtDate: number
  blockedByDep: number
}

/**
 * Compute burnup data points from task activity history.
 *
 * Derives daily snapshots of:
 *  - totalAtDate: cumulative count of tasks ever created (scope)
 *  - cumulativeDone: cumulative count of tasks completed/moved to done
 *  - blockedByDep: cumulative count of blocking events
 *
 * The chart covers the last 7 days, with a baseline computed from all
 * events that occurred before the 7-day window. This means the Y values
 * are absolute (not reset to zero at the window start), so the chart
 * shows the true project trajectory.
 *
 * No additional API calls or stored snapshots are needed — the function
 * reconstructs the timeline entirely from task.activity[] events and
 * task.createdAt timestamps already loaded in the board store.
 */
export function computeBurnup(tasks: Task[], board: Board | null): BurnupPoint[] {
  if (!board || tasks.length === 0) return []
  const doneColId = board.columns.find((c) => c.slug === "done")?.columnId
  const blockedColId = board.columns.find((c) => c.slug === "blocked")?.columnId

  type Ev = { ts: number; type: "created" | "completed" | "blocked" }
  const events: Ev[] = []

  for (const task of tasks) {
    if (task.archived) continue
    if (task.createdAt) events.push({ ts: new Date(task.createdAt).getTime(), type: "created" })
    if (task.activity) {
      for (const act of task.activity) {
        if (act.eventType === "task_completed")
          events.push({ ts: new Date(act.timestamp).getTime(), type: "completed" })
        if (act.eventType === "task_moved" && doneColId && act.details?.toColumnId === doneColId)
          events.push({ ts: new Date(act.timestamp).getTime(), type: "completed" })
        if (
          act.eventType === "task_moved" &&
          blockedColId &&
          act.details?.toColumnId === blockedColId
        )
          events.push({ ts: new Date(act.timestamp).getTime(), type: "blocked" })
        if (act.eventType === "task_blocked")
          events.push({ ts: new Date(act.timestamp).getTime(), type: "blocked" })
      }
    }
    const col = board.columns.find((c) => c.columnId === task.columnId)
    if (col?.slug === "done" && task.updatedAt) {
      const has = task.activity?.some(
        (a) =>
          a.eventType === "task_completed" ||
          (a.eventType === "task_moved" && a.details?.toColumnId === doneColId),
      )
      if (!has) events.push({ ts: new Date(task.updatedAt).getTime(), type: "completed" })
    }
  }

  if (events.length === 0) return []
  events.sort((a, b) => a.ts - b.ts)

  // Last 7 days
  const now = new Date()
  const sevenDaysAgo = new Date(now)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  sevenDaysAgo.setHours(0, 0, 0, 0)

  const dayMap = new Map<string, { created: number; completed: number; blocked: number }>()
  for (const ev of events) {
    const d = new Date(ev.ts)
    if (d < sevenDaysAgo) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    const e = dayMap.get(key) || { created: 0, completed: 0, blocked: 0 }
    if (ev.type === "created") e.created++
    else if (ev.type === "completed") e.completed++
    else if (ev.type === "blocked") e.blocked++
    dayMap.set(key, e)
  }

  // Fill missing days
  const days: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    )
  }

  // Cumulative from all history (not just 7 days)
  let cumDone = 0
  let totalCreated = 0
  let cumBlocked = 0

  // Count all events before 7-day window for baseline
  for (const ev of events) {
    if (ev.ts >= sevenDaysAgo.getTime()) break
    if (ev.type === "created") totalCreated++
    if (ev.type === "completed") cumDone++
  }

  const points: BurnupPoint[] = []
  for (const day of days) {
    const data = dayMap.get(day)
    if (data) {
      totalCreated += data.created
      cumDone += data.completed
      cumBlocked += data.blocked
    }
    const d = new Date(day + "T00:00:00")
    const label = d.toLocaleDateString("en", { month: "short", day: "numeric" })
    points.push({
      date: day,
      label,
      timestamp: d.getTime(),
      cumulativeDone: cumDone,
      totalAtDate: totalCreated,
      blockedByDep: cumBlocked,
    })
  }

  return points
}

// ============================================================================
// WORKSPACE MEMBERS — Unified assignee types (agents + humans)
// ============================================================================

/** Distinguishes agent (AI) from human (workspace owner / invited members). */
export type MemberType = "agent" | "human"

/**
 * Unified entry in the agentMap — represents anyone who can be assigned a task.
 * The `type` field is optional for backward compatibility with code that
 * constructs plain `{ name, avatarUrl }` objects.
 */
export interface AgentMapEntry {
  name: string
  avatarUrl?: string
  /** 'agent' for AI agents, 'human' for workspace owner and invited members. */
  type?: MemberType
  /** Optional role label (e.g. 'owner', 'member') — for future invited members. */
  role?: string
}

/** Convenience type alias — the agentMap is a record of AgentMapEntry. */
export type AgentMap = Record<string, AgentMapEntry>

/**
 * Avatar border colors for distinguishing humans from agents.
 * Matches the pattern already used in MissionControl.tsx:
 *   - HUMAN_BORDER (teal) for humans (workspace owner, invited members)
 *   - AGENT_BORDER (indigo) for AI agents
 */
export const HUMAN_BORDER_COLOR = "#14B8A6"
export const AGENT_BORDER_COLOR = "#5E6AD2"

/**
 * Returns the avatar border color for a given member ID + optional type.
 * Falls back to ID-prefix detection (agent_ vs user_) when type is not set,
 * maintaining backward compatibility with entries that don't carry `type`.
 */
export function getAvatarBorderColor(memberId: string, type?: MemberType): string {
  if (type === "human") return HUMAN_BORDER_COLOR
  if (type === "agent") return AGENT_BORDER_COLOR
  // Fallback: infer from ID prefix
  return memberId.startsWith("agent_") ? AGENT_BORDER_COLOR : HUMAN_BORDER_COLOR
}

/**
 * Returns the member type for a given ID, using ID-prefix detection.
 * `agent_` prefix → 'agent', `user_` prefix (or anything else) → 'human'.
 */
export function inferMemberType(memberId: string): MemberType {
  return memberId.startsWith("agent_") ? "agent" : "human"
}
