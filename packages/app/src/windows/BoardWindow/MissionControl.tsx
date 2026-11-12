/**
 * Mission Control — the project's "Misión" tab in the OS prototype language.
 *
 * Two-column grid (1.55fr / 1fr, one column under a 980px pane):
 *   Left:  hero Card (serif name · stacked status bar · legend) → Stat tiles
 *          → Activity feed (LGroup of LRows)
 *   Right: Burn chart Card → Team (LGroup of member rows with their tasks)
 *
 * Colours come from `useColors()` + the semantic ramps; status dots are the
 * column colours (backlog grey · todo mint · doing amber · blocked red ·
 * review violet · done green). No bold — hierarchy is the text step.
 */

import React, { useEffect, useMemo, useRef, useState } from "react"
import { Platform, Pressable, View, TouchableOpacity } from "react-native"
import { useTranslation } from "react-i18next"
import { AppSpinner } from "../../components/ui"
import type { Board, Project, Task } from "../../store/boardStore"
import type { BoardFeedEvent } from "../../services/BoardApi"
import { timeAgoNatural, computeBurnup, type AgentMapEntry } from "./board-utils"
import { BurnChart } from "./BurnChart"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { CompactMarkdown } from "./CompactMarkdown"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  Card,
  Dot,
  EmptyHint,
  LGroup,
  LRow,
  Page,
  Ph,
  SectionLabel,
  Stat,
  Stats,
  T,
  type BadgeTone,
} from "../../components/ui/ds"

// ============================================================================
// TYPES
// ============================================================================

interface AgentRelationshipState {
  agentId: string
  agentName: string
  avatarUrl?: string
  slots: number
  playEnabled: boolean
  activeSlots: number
}

interface MissionControlProps {
  project: Project | null
  board: Board | null
  tasks: Task[]
  /** Live board feed from the store (websocket) — accepted so the parent can
   *  pass it through; the activity list is derived from task activity. */
  boardFeed?: BoardFeedEvent[] | null
  agentRelationships: AgentRelationshipState[]
  agentMap: Record<string, AgentMapEntry>
  globalAgentMap?: Record<string, AgentMapEntry>
  onOpenConversation?: (channelId: string) => void
  onOpenTask?: (taskId: string) => void
  userAvatarUrl?: string
}

// Column colours — the prototype's status dots (semantic ramps, theme-agnostic)
const COL_COLORS: Record<string, string> = {
  backlog: semantic.main500,
  todo: semantic.mint300,
  in_progress: semantic.amber,
  blocked: semantic.red,
  review: semantic.purple200,
  done: semantic.green,
}

// Column → Badge tone (the tinted pills of the prototype)
const COL_TONE: Record<string, BadgeTone> = {
  backlog: "muted",
  todo: "m",
  in_progress: "a",
  blocked: "r",
  review: "i",
  done: "g",
}

const HUMAN_COLOR = semantic.mint300
const ACCENT = semantic.purple200
const MUTED = semantic.main500

// ─── Activity feed animation CSS (web only) ──────────────────────────────────
// Fade-in + subtle violet pulse when a new item appears at the top of the feed.
const ACTIVITY_FEED_CSS = `
  @keyframes activityItemEnter {
    0% {
      opacity: 0;
      transform: translateY(-8px) scale(0.97);
    }
    60% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    100% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  @keyframes activityItemPulse {
    0% { background-color: rgba(111, 39, 255, 0); }
    20% { background-color: rgba(111, 39, 255, 0.14); }
    100% { background-color: rgba(111, 39, 255, 0); }
  }
  .activity-item-new {
    animation:
      activityItemEnter 0.5s ease-out,
      activityItemPulse 3.5s ease-out 0.3s;
  }
`

// Column priority for sorting team tasks: running first, then by workflow stage, done last
const COL_PRIORITY: Record<string, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  blocked: 3,
  review: 4,
  done: 5,
}

// ============================================================================
// ACTIVITY
// ============================================================================

interface ActivityItem {
  taskId: string
  taskTitle: string
  eventType: string
  actor: string
  actorName: string
  actorAvatarUrl?: string
  timestamp: string
  channelId?: string
  details?: {
    fromColumn?: string
    toColumn?: string
    agentId?: string
    targetAgentName?: string
    oldPriority?: string
    newPriority?: string
    fromStatus?: string
    toStatus?: string
    note?: string
    running?: boolean
  }
  noteText?: string
  taskColumnSlug?: string
}

// ─── Actor type helpers ─────────────────────────────────────────────────────

/** True for any system-prefixed actor ('system', 'system:autoplay', etc.) */
function isSystemActor(actor: string | undefined | null): boolean {
  if (!actor) return false
  return actor === "system" || actor.startsWith("system:")
}

/** True when the actor is null/undefined — indicates a bug, not a system event */
function isUnknownActor(actor: string | undefined | null): boolean {
  return !actor
}

/** Inline Teros logo as data URI — 6 hexagon circles, white on transparent */
const TEROS_LOGO_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="256" cy="76.8" r="35.84" fill="white"/>' +
      '<circle cx="411.2" cy="166.4" r="35.84" fill="white"/>' +
      '<circle cx="100.8" cy="166.4" r="35.84" fill="white"/>' +
      '<circle cx="411.2" cy="345.6" r="35.84" fill="white"/>' +
      '<circle cx="100.8" cy="345.6" r="35.84" fill="white"/>' +
      '<circle cx="256" cy="435.2" r="35.84" fill="white"/>' +
      "</svg>",
  )

// ─── Actor resolution ───────────────────────────────────────────────────────

function resolveActorName(
  actor: string | undefined | null,
  agentMap: Record<string, AgentMapEntry>,
  globalAgentMap?: Record<string, AgentMapEntry>,
): string {
  // Case 4: null/undefined actor — indicates a bug, show "?" to make it visible
  if (isUnknownActor(actor)) return "?"
  // Case 3: system actor
  if (isSystemActor(actor)) return "System"
  // Case 2: known user
  if (actor === "user_0000000000000000") return "Pablo"
  // Case 1: known agent — look up in agent maps
  if (!actor) return "?"
  const info = agentMap[actor] ?? globalAgentMap?.[actor]
  if (info?.name) return info.name
  // Fallback for agent/user IDs not in maps — show short ID so it's identifiable
  if (actor.startsWith("agent_")) return actor.slice(6, 12)
  if (actor.startsWith("user_")) return actor.slice(6, 12)
  return actor
}

function resolveActorAvatar(
  actor: string | undefined | null,
  agentMap: Record<string, AgentMapEntry>,
  userAvatarUrl?: string,
  globalAgentMap?: Record<string, AgentMapEntry>,
): string | undefined {
  // Case 4: null/undefined actor — return undefined so the "?" fallback avatar renders
  if (isUnknownActor(actor)) return undefined
  // Case 3: system actor — no avatar (Teros logo is used by the renderer)
  if (isSystemActor(actor)) return undefined
  // Case 2: known user
  if (actor === "user_0000000000000000") return userAvatarUrl
  // Case 1: known agent
  if (!actor) return undefined
  return agentMap[actor]?.avatarUrl ?? globalAgentMap?.[actor]?.avatarUrl
}

function collectActivity(
  tasks: Task[],
  agentMap: Record<string, AgentMapEntry>,
  userAvatarUrl?: string,
  globalAgentMap?: Record<string, AgentMapEntry>,
  columnSlugMap?: Record<string, string>,
  boardFeed?: BoardFeedEvent[] | null,
): ActivityItem[] {
  // Primary source: the indexed board_events feed (fetched once via
  // board.get-board-feed). Since the board list projection stripped
  // task.activity / task.progressNotes from list payloads (large-board
  // timeout fix), the per-task arrays are no longer guaranteed to be
  // present — the feed is the canonical activity source.
  if (boardFeed) {
    const channelByTask = new Map<string, string | undefined>()
    for (const t of tasks) channelByTask.set(t.taskId, t.channelId)
    const colSlugByTask = new Map<string, string | undefined>()
    for (const t of tasks) colSlugByTask.set(t.taskId, columnSlugMap?.[t.columnId])

    const items: ActivityItem[] = []
    for (const ev of boardFeed) {
      // board_events categories are `task.<verb>`; the activity renderer
      // keys on the legacy bare verb (`moved`, `created`, …).
      const eventType = ev.eventType.startsWith("task.")
        ? ev.eventType.slice("task.".length)
        : ev.eventType
      // Same skip rules as the per-task path below: progress notes render
      // from their own event (with note text), running/linked are internal
      // signals that add noise to the feed.
      if (eventType === "running_changed" || eventType === "linked") continue
      const details = { ...(ev.details as ActivityItem["details"]) }
      if (details?.agentId) {
        details.targetAgentName = resolveActorName(details.agentId, agentMap, globalAgentMap)
      }
      items.push({
        taskId: ev.taskId ?? "",
        taskTitle: ev.taskTitle ?? "",
        eventType,
        actor: ev.actor,
        actorName: resolveActorName(ev.actor, agentMap, globalAgentMap),
        actorAvatarUrl: resolveActorAvatar(ev.actor, agentMap, userAvatarUrl, globalAgentMap),
        timestamp: ev.timestamp,
        channelId: channelByTask.get(ev.taskId ?? ""),
        details,
        // progress-note events carry the note text in details.note
        noteText:
          eventType === "progress_note"
            ? (ev.details as { note?: string } | undefined)?.note
            : undefined,
        taskColumnSlug: colSlugByTask.get(ev.taskId ?? ""),
      })
    }
    return items.slice(0, 30)
  }

  // Fallback: per-task activity arrays (small boards / older payloads that
  // still carry them). Kept so the feed degrades gracefully if the board
  // feed fetch failed (BoardWindow falls back to null).
  const items: ActivityItem[] = []
  for (const task of tasks) {
    const taskColumnSlug = columnSlugMap?.[task.columnId]
    if (task.activity) {
      for (const act of task.activity) {
        // Skip progress_note events here — they're already covered by the
        // progressNotes loop below which includes the note text. Without this
        // filter, each note shows up twice: once without text (from activity)
        // and once with text (from progressNotes).
        if (act.eventType === "progress_note") continue
        // Skip running_changed events — they're internal start/stop signals
        // that don't add value to the user-facing activity feed.
        if (act.eventType === "running_changed") continue
        // Skip linked events — linking a conversation is an internal side-effect
        // of starting a task, not meaningful to show in the activity feed.
        if (act.eventType === "linked") continue
        const details = { ...act.details }
        // Resolve target agent name for assignment events
        if (details?.agentId) {
          details.targetAgentName = resolveActorName(details.agentId, agentMap, globalAgentMap)
        }
        items.push({
          taskId: task.taskId,
          taskTitle: task.title,
          eventType: act.eventType,
          actor: act.actor,
          actorName: resolveActorName(act.actor, agentMap, globalAgentMap),
          actorAvatarUrl: resolveActorAvatar(act.actor, agentMap, userAvatarUrl, globalAgentMap),
          timestamp: act.timestamp,
          channelId: task.channelId,
          details,
          taskColumnSlug,
        })
      }
    }
    if (task.progressNotes) {
      for (const note of task.progressNotes) {
        items.push({
          taskId: task.taskId,
          taskTitle: task.title,
          eventType: "progress_note",
          actor: note.actor,
          actorName: resolveActorName(note.actor, agentMap, globalAgentMap),
          actorAvatarUrl: resolveActorAvatar(note.actor, agentMap, userAvatarUrl, globalAgentMap),
          timestamp: note.timestamp,
          channelId: task.channelId,
          noteText: note.text,
          taskColumnSlug,
        })
      }
    }
  }
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return items.slice(0, 30)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}

// ── Event verb + icon ──────────────────────────────────────────────────────

interface EventVerb {
  verb: string // past-tense action, e.g. "created", "moved"
  icon: string // emoji or short label for the event badge
  color: string // accent color for the badge
  fromBadge?: { label: string; color: string } // colored pill for movement events
  toBadge?: { label: string; color: string } // colored pill for movement events
  targetAgentId?: string // agent being assigned (for assigned events) — used to show their avatar
}

// Resolve a column NAME (e.g. "To Do", "In Progress") to its color via slug matching
function colNameToColor(name?: string): string | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase().replace(/\s+/g, "_")
  if (COL_COLORS[lower]) return COL_COLORS[lower]
  const noSpaces = name.toLowerCase().replace(/\s+/g, "")
  if (COL_COLORS[noSpaces]) return COL_COLORS[noSpaces]
  return undefined
}

function getEventVerb(item: ActivityItem): EventVerb {
  const d = item.details
  switch (item.eventType) {
    case "created":
      return { verb: "created this task", icon: "", color: COL_COLORS.todo }
    case "moved": {
      const toColSlug = d?.toColumn?.toLowerCase().replace(/\s+/g, "_")
      const colColor = toColSlug && COL_COLORS[toColSlug] ? COL_COLORS[toColSlug] : ACCENT
      const fromColor = colNameToColor(d?.fromColumn) ?? MUTED
      const toColor = colNameToColor(d?.toColumn) ?? colColor
      return {
        verb: "moved",
        icon: "",
        color: colColor,
        fromBadge: d?.fromColumn ? { label: d.fromColumn, color: fromColor } : undefined,
        toBadge: { label: d?.toColumn ?? "?", color: toColor },
      }
    }
    case "status_changed": {
      const toStatus = d?.toStatus?.toLowerCase()
      const statusColor = toStatus && COL_COLORS[toStatus] ? COL_COLORS[toStatus] : ACCENT
      const fromColor = colNameToColor(d?.fromStatus) ?? MUTED
      const toColor = colNameToColor(d?.toStatus) ?? statusColor
      return {
        verb: "changed status",
        icon: "",
        color: statusColor,
        fromBadge: { label: d?.fromStatus ?? "?", color: fromColor },
        toBadge: { label: d?.toStatus ?? "?", color: toColor },
      }
    }
    case "started":
      return { verb: "started working on this task", icon: "", color: COL_COLORS.in_progress }
    case "running_changed":
      return {
        verb: d?.running ? "started running" : "stopped running",
        icon: "",
        color: COL_COLORS.in_progress,
      }
    case "assigned": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "assigned to", icon: "", color: colColor, targetAgentId: d?.agentId }
    }
    case "unassigned": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "unassigned", icon: "", color: colColor }
    }
    case "priority_changed": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return {
        verb: `priority ${d?.oldPriority ?? "?"} → ${d?.newPriority ?? "?"}`,
        icon: "",
        color: colColor,
      }
    }
    case "linked": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return {
        verb: "linked a conversation to",
        icon: "",
        color: colColor,
        targetAgentId: d?.agentId,
      }
    }
    case "progress_note": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "added a note", icon: "", color: colColor }
    }
    case "dependency_added": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "added a dependency", icon: "", color: colColor }
    }
    case "dependency_removed": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "removed a dependency", icon: "", color: colColor }
    }
    case "updated": {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: "updated this task", icon: "", color: colColor }
    }
    case "deleted":
      return { verb: "deleted this task", icon: "", color: COL_COLORS.blocked }
    default: {
      const colSlug = item.taskColumnSlug?.toLowerCase()
      const colColor = colSlug && COL_COLORS[colSlug] ? COL_COLORS[colSlug] : MUTED
      return { verb: item.eventType.replace(/_/g, " "), icon: "", color: colColor }
    }
  }
}

function formatTime(timestamp: string): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

function formatMinutes(timestamp: string): string {
  const d = new Date(timestamp)
  return `:${String(d.getMinutes()).padStart(2, "0")}`
}

function formatHourLabel(timestamp: string): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, "0")}:00`
}

function getHourKey(timestamp: string): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
}

function formatDayLabel(timestamp: string): string {
  const d = new Date(timestamp)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const itemDay = new Date(d)
  itemDay.setHours(0, 0, 0, 0)

  if (itemDay.getTime() === today.getTime()) return "Today"
  if (itemDay.getTime() === yesterday.getTime()) return "Yesterday"

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const base = `${months[d.getMonth()]} ${d.getDate()}`

  const diffDays = Math.round((today.getTime() - itemDay.getTime()) / 86400000)
  if (diffDays > 0) {
    return `${base.toUpperCase()} (${diffDays} DAY${diffDays > 1 ? "S" : ""} AGO)`
  }
  return base.toUpperCase()
}

function getDayKey(timestamp: string): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

interface ActivityGroup {
  dayLabel: string
  dayKey: string
  items: ActivityItem[]
}

function groupActivityByDay(items: ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = []
  const daySeen = new Map<string, number>()

  for (const item of items) {
    const dayKey = getDayKey(item.timestamp)
    let dayIdx = daySeen.get(dayKey)
    if (dayIdx === undefined) {
      dayIdx = groups.length
      groups.push({ dayLabel: formatDayLabel(item.timestamp), dayKey, items: [] })
      daySeen.set(dayKey, dayIdx)
    }
    groups[dayIdx].items.push(item)
  }

  return groups
}

// Returns hour:minute key for comparing consecutive items (to avoid repeating the same time)
function getHourMinuteKey(timestamp: string): string {
  const d = new Date(timestamp)
  return `${d.getHours()}:${d.getMinutes()}`
}

// ── Column name → Badge tone (movement pills) ─────────────────────────────────

function colNameToTone(name?: string): BadgeTone {
  if (!name) return "neutral"
  const key = name.toLowerCase().replace(/\s+/g, "_")
  return COL_TONE[key] ?? COL_TONE[name.toLowerCase().replace(/\s+/g, "")] ?? "neutral"
}

// ── MovementBadge: tinted pill for from/to column in movement events ──────────

function MovementBadge({ label }: { label: string }) {
  return (
    <Badge tone={colNameToTone(label)} dot sm>
      {truncate(label, 14)}
    </Badge>
  )
}

// ── NoteText: expandable note with Markdown rendering + toggle ────────────────

const NOTE_COLLAPSED_HEIGHT = 80 // ~4-5 lines

function NoteText({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const c = useColors()

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPress={() => setExpanded((v) => !v)}
      style={{ marginTop: 4, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.borderStrong }}
    >
      {/* Markdown content — collapsible by height */}
      <View
        style={{
          maxHeight: expanded ? 5000 : NOTE_COLLAPSED_HEIGHT,
          overflow: "hidden",
          ...(Platform.OS === "web" ? ({ transition: "max-height 0.3s ease" } as any) : {}),
        }}
      >
        <CompactMarkdown text={text} fontSize={12} />
      </View>

      {/* Fade overlay when collapsed */}
      {!expanded && Platform.OS === "web" && (
        <View
          style={
            {
              height: 24,
              marginTop: -24,
              marginBottom: 2,
              background: `linear-gradient(to bottom, transparent, ${c.bgStep})`,
              pointerEvents: "none",
            } as any
          }
        />
      )}

      {/* Toggle indicator */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 }}>
        <T step="codenote" tone="text3">
          {expanded
            ? t("board.mission.showLess", { defaultValue: "show less" })
            : t("board.mission.showMore", { defaultValue: "show more" })}
        </T>
        <Ph name={expanded ? "caret-up" : "caret-down"} size={10} color={c.text3} />
      </View>
    </TouchableOpacity>
  )
}

// ── ActorAvatar: feed avatar — unknown "?" (red), system (ink disc), else Avatar

/** Inline Teros logo as data URI — 6 hexagon circles, drawn in `color`. */
function terosLogoUri(color: string): string {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">' +
        `<circle cx="256" cy="76.8" r="35.84" fill="${color}"/>` +
        `<circle cx="411.2" cy="166.4" r="35.84" fill="${color}"/>` +
        `<circle cx="100.8" cy="166.4" r="35.84" fill="${color}"/>` +
        `<circle cx="411.2" cy="345.6" r="35.84" fill="${color}"/>` +
        `<circle cx="100.8" cy="345.6" r="35.84" fill="${color}"/>` +
        `<circle cx="256" cy="435.2" r="35.84" fill="${color}"/>` +
        "</svg>",
    )
  )
}

function ActorAvatar({
  actor,
  name,
  avatarUrl,
  size = 22,
}: {
  actor?: string | null
  name: string
  avatarUrl?: string
  size?: number
}) {
  const c = useColors()
  if (isUnknownActor(actor)) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.tint.r.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <T step="code" color={c.tint.r.tx}>
          ?
        </T>
      </View>
    )
  }
  if (isSystemActor(actor)) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.inkPill,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {Platform.OS === "web" ? (
          <img
            src={terosLogoUri(c.inkPillText)}
            style={{ width: size * 0.6, height: size * 0.6, objectFit: "contain" }}
            alt="Teros"
          />
        ) : (
          <Ph name="hexagon" size={size * 0.6} color={c.inkPillText} />
        )}
      </View>
    )
  }
  return (
    <Avatar name={name} imageUrl={avatarUrl} size={size} isAgent={!!actor?.startsWith("agent_")} />
  )
}

// ── StatusBar: the stacked colour bar + legend ───────────────────────────────

function StatusBar({
  distribution,
  total,
}: {
  distribution: { columnId: string; name: string; slug: string; count: number }[]
  total: number
}) {
  const c = useColors()
  return (
    <View style={{ gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          height: 8,
          borderRadius: 100,
          overflow: "hidden",
          backgroundColor: c.wash2,
          gap: 2,
        }}
      >
        {distribution.map((col) => {
          const pct = total > 0 ? (col.count / total) * 100 : 0
          if (pct === 0) return null
          return (
            <View
              key={col.columnId}
              style={{ width: `${pct}%`, backgroundColor: COL_COLORS[col.slug] || MUTED }}
            />
          )
        })}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        {distribution.map((col) => (
          <View key={col.columnId} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Dot color={COL_COLORS[col.slug] || MUTED} size={6} />
            <T step="codenote" tone="text2">
              {col.name}
            </T>
            <T step="codenote" tone="text3">
              {col.count}
            </T>
          </View>
        ))}
      </View>
    </View>
  )
}

// ── TeamTaskRow: one task under a team member ────────────────────────────────

function TeamTaskRow({
  title,
  color,
  running,
  when,
  onPress,
}: {
  title: string
  color: string
  running?: boolean
  when: string
  onPress?: () => void
}) {
  const c = useColors()
  const [hover, setHover] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 5,
          paddingHorizontal: 8,
          marginHorizontal: -8,
          borderRadius: 8,
          backgroundColor: hover ? c.nestHover : "transparent",
        },
        Platform.OS === "web"
          ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
          : null,
      ]}
    >
      <Dot color={color} size={6} />
      {running ? <AppSpinner size="xs" variant="warning" /> : null}
      <T step="12" tone="text2" ellipsis style={{ flex: 1 }}>
        {title}
      </T>
      <T step="codenote" tone="text3" style={{ minWidth: 64, textAlign: "right" }}>
        {when}
      </T>
    </Pressable>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function MissionControl({
  project,
  board,
  tasks,
  boardFeed,
  agentRelationships,
  agentMap,
  globalAgentMap,
  onOpenConversation,
  onOpenTask,
  userAvatarUrl,
}: MissionControlProps) {
  const { t, i18n } = useTranslation()
  const locale = (i18n.language?.startsWith("es") ? "es" : "en") as "en" | "es"
  const c = useColors()

  // ── Responsive: two columns above a 980px pane ──────────────────────────
  const [paneWidth, setPaneWidth] = useState(0)
  const twoCol = paneWidth === 0 || paneWidth > 980

  // ── Stats ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const active = tasks.filter((t) => !t.archived)
    const total = active.length
    const col = (slug: string) =>
      active.filter((t) => board?.columns.find((c) => c.columnId === t.columnId)?.slug === slug)
        .length
    const done = col("done")
    const inProgress = col("in_progress")
    const blocked = col("blocked")
    const review = col("review")
    const todo = col("todo")
    const backlog = col("backlog")

    // Done today: tasks that were moved to Done column today.
    // Reads the board_events feed (task.moved events carry the column NAME in
    // details.toColumn) — task.activity no longer travels in list payloads
    // (large-board projection fix). Falls back to updatedAt when the feed is
    // unavailable.
    const doneColId = board?.columns.find((col) => col.slug === "done")?.columnId
    const doneColName = board?.columns.find((col) => col.slug === "done")?.name
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const movedToDoneToday = new Set(
      (boardFeed ?? [])
        .filter(
          (ev) =>
            ev.eventType === "task.moved" &&
            ev.details?.toColumn === doneColName &&
            new Date(ev.timestamp) >= todayStart,
        )
        .map((ev) => ev.taskId ?? ""),
    )
    const doneToday = active.filter((t) => {
      if (t.columnId !== doneColId) return false
      if (movedToDoneToday.has(t.taskId)) return true
      // Fallback: no matching feed event, use updatedAt
      return t.updatedAt && new Date(t.updatedAt) >= todayStart
    }).length

    // To Do assigned: tasks in To Do column that have an assignee (ready to work)
    const todoColId = board?.columns.find((col) => col.slug === "todo")?.columnId
    const todoAssigned = active.filter(
      (t) => t.columnId === todoColId && t.assignedAgentId && !t.archived,
    ).length

    return { total, done, inProgress, blocked, review, todo, backlog, doneToday, todoAssigned }
  }, [tasks, board])

  // ── Distribution ────────────────────────────────────────────────────────

  const distribution = useMemo(() => {
    if (!board) return []
    return board.columns
      .map((col) => ({
        ...col,
        count: tasks.filter((t) => t.columnId === col.columnId && !t.archived).length,
      }))
      .filter((col) => col.slug !== "done" || col.count > 0) // always show done
  }, [board, tasks])

  // ── Activity ────────────────────────────────────────────────────────────

  const recentActivity = useMemo(() => {
    const columnSlugMap: Record<string, string> = {}
    if (board) {
      for (const col of board.columns) {
        columnSlugMap[col.columnId] = col.slug
      }
    }
    return collectActivity(
      tasks,
      agentMap,
      userAvatarUrl,
      globalAgentMap,
      columnSlugMap,
      boardFeed ?? null,
    )
  }, [tasks, agentMap, userAvatarUrl, globalAgentMap, board, boardFeed])
  const activityGroups = useMemo(() => groupActivityByDay(recentActivity), [recentActivity])

  // ── New activity item detection (for pulse/fade-in animation) ───────────────
  // Track which item keys we've already seen. Items that appear for the first
  // time get the `activity-item-new` class, which triggers a fade-in + pulse
  // animation. After the animation duration, we clear the set so the class
  // is removed and doesn't re-trigger on re-renders.
  const newItemKeysRef = useRef<Set<string>>(new Set())
  const isFirstLoadRef = useRef(true)
  const [newItemKeys, setNewItemKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    const prevKeys = newItemKeysRef.current
    const currentKeys = new Set(recentActivity.map((item) => `${item.taskId}-${item.timestamp}`))
    // Skip the first load — don't animate items that were already there on mount
    if (isFirstLoadRef.current) {
      isFirstLoadRef.current = false
      newItemKeysRef.current = currentKeys
      return
    }
    // Find items that are in current but not in previous — these are new
    const fresh = new Set<string>()
    for (const key of currentKeys) {
      if (!prevKeys.has(key)) fresh.add(key)
    }
    if (fresh.size > 0) {
      setNewItemKeys(fresh)
      // Clear the animation class after the animation completes
      const timer = setTimeout(() => setNewItemKeys(new Set()), 4500)
      // Update ref for next comparison
      newItemKeysRef.current = currentKeys
      return () => clearTimeout(timer)
    }
    // No new items — just update the ref
    newItemKeysRef.current = currentKeys
  }, [recentActivity])

  // ── Burnup ──────────────────────────────────────────────────────────────

  const burnupPoints = useMemo(() => computeBurnup(tasks, board), [tasks, board])

  // ── Team ────────────────────────────────────────────────────────────────

  const teamMembers = useMemo(() => {
    // Agents from agentRelationships
    const agents = agentRelationships.map((r) => {
      const agentTasks = tasks.filter((t) => t.assignedAgentId === r.agentId && !t.archived)
      const mapped = agentTasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        columnSlug: board?.columns.find((c) => c.columnId === t.columnId)?.slug || "backlog",
        updatedAt: t.updatedAt,
        running: t.running,
      }))
      // Sort: running tasks first, then by column priority, done last
      mapped.sort((a, b) => {
        if (a.running && !b.running) return -1
        if (!a.running && b.running) return 1
        return (COL_PRIORITY[a.columnSlug] ?? 99) - (COL_PRIORITY[b.columnSlug] ?? 99)
      })
      return {
        id: r.agentId,
        name: r.agentName,
        avatarUrl: r.avatarUrl,
        type: "agent" as const,
        isWorking: r.activeSlots > 0,
        tasks: mapped,
      }
    })

    // Humans: entries whose ID starts with 'user_' (Pablo, etc.)
    // Agents in agentMap/globalAgentMap that aren't in agentRelationships
    // are still agents (supervisors like Alice) — only real humans go here.
    const agentIds = new Set(agentRelationships.map((r) => r.agentId))
    const humans = Object.entries(agentMap)
      .filter(([id]) => id.startsWith("user_"))
      .map(([id, info]) => {
        const humanTasks = tasks.filter((t) => t.assignedAgentId === id && !t.archived)
        const mapped = humanTasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          columnSlug: board?.columns.find((c) => c.columnId === t.columnId)?.slug || "backlog",
          updatedAt: t.updatedAt,
          running: t.running,
        }))
        mapped.sort((a, b) => {
          if (a.running && !b.running) return -1
          if (!a.running && b.running) return 1
          return (COL_PRIORITY[a.columnSlug] ?? 99) - (COL_PRIORITY[b.columnSlug] ?? 99)
        })
        return {
          id,
          name: info.name,
          avatarUrl: info.avatarUrl,
          type: "human" as const,
          isWorking: humanTasks.some((t) => t.running),
          tasks: mapped,
        }
      })

    // Add supervisor agents (globalAgentMap) that aren't already in agentRelationships
    const existingIds = new Set([...agentIds, ...humans.map((h) => h.id)])
    const supervisors = Object.entries(globalAgentMap || {})
      .filter(([id]) => !existingIds.has(id))
      .map(([id, info]) => {
        const supTasks = tasks.filter((t) => t.assignedAgentId === id && !t.archived)
        const mapped = supTasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          columnSlug: board?.columns.find((col) => col.columnId === t.columnId)?.slug || "backlog",
          updatedAt: t.updatedAt,
          running: t.running,
        }))
        mapped.sort((a, b) => {
          if (a.running && !b.running) return -1
          if (!a.running && b.running) return 1
          return (COL_PRIORITY[a.columnSlug] ?? 99) - (COL_PRIORITY[b.columnSlug] ?? 99)
        })
        return {
          id,
          name: info.name,
          avatarUrl: info.avatarUrl,
          type: "agent" as const,
          isWorking: supTasks.some((t) => t.running),
          tasks: mapped,
        }
      })

    return [...agents, ...supervisors, ...humans]
  }, [agentRelationships, agentMap, globalAgentMap, tasks, board])

  // ── Project meta ────────────────────────────────────────────────────────

  const projectAge = useMemo(() => {
    if (!project?.createdAt) return null
    return timeAgoNatural(project.createdAt, locale)
  }, [project?.createdAt])

  const metaLine = [
    t("board.mission.metaTasks", { count: stats.total, defaultValue: "{{count}} tasks" }),
    t("board.mission.metaTeam", {
      count: teamMembers.length,
      defaultValue: "{{count}} team members",
    }),
    projectAge
      ? t("board.mission.metaCreated", { when: projectAge, defaultValue: "created {{when}}" })
      : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const statTiles = [
    {
      v: stats.todoAssigned,
      l: t("board.mission.statTodo", { defaultValue: "To Do" }),
      sub: t("board.mission.statTodoSub", { defaultValue: "assigned" }),
    },
    {
      v: stats.inProgress,
      l: t("board.mission.statDoing", { defaultValue: "In Progress" }),
      sub: t("board.mission.statDoingSub", { defaultValue: "WIP" }),
    },
    {
      v: stats.blocked,
      l: t("board.mission.statBlocked", { defaultValue: "Blocked" }),
      sub: t("board.mission.statBlockedSub", { defaultValue: "by dependency" }),
    },
    {
      v: stats.review,
      l: t("board.mission.statReview", { defaultValue: "Review" }),
      sub: t("board.mission.statReviewSub", { defaultValue: "waiting on you" }),
      accent: true,
    },
    {
      v: stats.doneToday,
      l: t("board.mission.statDoneToday", { defaultValue: "Done today" }),
      sub: t("board.mission.statDoneTodaySub", { defaultValue: "throughput" }),
    },
  ]

  // ── Render ──────────────────────────────────────────────────────────────

  const columnStyle = (grow: number) =>
    twoCol
      ? ({ flexGrow: grow, flexShrink: 1, flexBasis: 0, minWidth: 0, gap: 16 } as const)
      : ({ width: "100%", minWidth: 0, gap: 16 } as const)

  return (
    <Page fluid testID="mission-control">
      {Platform.OS === "web" && <style>{ACTIVITY_FEED_CSS}</style>}
      <View
        onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}
        style={{
          flexDirection: twoCol ? "row" : "column",
          alignItems: "flex-start",
          gap: 16,
          maxWidth: 1400,
        }}
      >
        {/* ═══ LEFT COLUMN ═══ */}
        <View style={columnStyle(1.55)}>
          {/* Hero card: name · description · status bar */}
          <Card pad={20}>
            <T step="2xl">{project?.name || t("board.selectProject")}</T>
            {project?.description ? (
              <T step="sm" tone="text2" style={{ marginTop: 8, maxWidth: 560 }}>
                {project.description}
              </T>
            ) : null}
            <T step="codenote" tone="text3" style={{ marginTop: 10 }}>
              {metaLine}
            </T>
            <View style={{ marginTop: 18 }}>
              <StatusBar distribution={distribution} total={stats.total} />
            </View>
          </Card>

          {/* Stat tiles */}
          <Stats cols={5}>
            {statTiles.map((m) => (
              <Stat key={m.l} v={m.v} label={m.l} sub={m.sub} accent={m.accent && m.v > 0} />
            ))}
          </Stats>

          {/* Activity feed */}
          <View>
            <SectionLabel
              label={t("board.mission.activity", { defaultValue: "Activity" })}
              count={recentActivity.length}
            />
            {recentActivity.length === 0 ? (
              <EmptyHint>
                {t("board.mission.activityEmpty", {
                  defaultValue: "No activity yet — it shows up here as agents work.",
                })}
              </EmptyHint>
            ) : (
              <LGroup>
                {activityGroups.flatMap((group) => [
                  // Day header
                  <View
                    key={`day-${group.dayKey}`}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingHorizontal: 16,
                      paddingVertical: 8,
                      backgroundColor: c.nest,
                    }}
                  >
                    <T step="xs" tone="text2">
                      {group.dayLabel}
                    </T>
                    <View style={{ flex: 1 }} />
                    <T step="codenote" tone="text3">
                      {t("board.mission.eventCount", {
                        count: group.items.length,
                        defaultValue: "{{count}} events",
                      })}
                    </T>
                  </View>,
                  ...group.items.map((item, idx) => {
                    const verb = getEventVerb(item)
                    // Show time only when it differs from the previous item in this group
                    const prevItem = idx > 0 ? group.items[idx - 1] : null
                    const showTime =
                      !prevItem ||
                      getHourMinuteKey(prevItem.timestamp) !== getHourMinuteKey(item.timestamp)
                    const itemKey = `${item.taskId}-${item.timestamp}`
                    const isNew = newItemKeys.has(itemKey)
                    return (
                      <LRow
                        key={`${item.taskId}-${item.timestamp}-${idx}`}
                        padV={10}
                        gap={10}
                        onPress={onOpenTask ? () => onOpenTask(item.taskId) : undefined}
                        style={
                          [
                            { alignItems: "flex-start" },
                            Platform.OS === "web" && isNew
                              ? ({
                                  animation:
                                    "activityItemEnter 0.5s ease-out, activityItemPulse 3.5s ease-out 0.3s",
                                } as any)
                              : null,
                          ] as any
                        }
                      >
                        {/* Time — only shown when it changes from the previous item */}
                        <T
                          step="codenote"
                          color={showTime ? c.text3 : "transparent"}
                          style={{ minWidth: 40, paddingTop: 4 }}
                        >
                          {formatTime(item.timestamp)}
                        </T>
                        <ActorAvatar
                          actor={item.actor}
                          name={item.actorName}
                          avatarUrl={item.actorAvatarUrl}
                        />
                        {/* Content */}
                        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                          <View
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              gap: 6,
                              flexWrap: "wrap",
                            }}
                          >
                            <T step="sm">{item.actorName}</T>
                            <T step="sm" tone="text2">
                              {verb.verb}
                            </T>
                            {/* Target agent for assigned events */}
                            {verb.targetAgentId &&
                              (() => {
                                const targetInfo =
                                  agentMap[verb.targetAgentId] ??
                                  globalAgentMap?.[verb.targetAgentId]
                                const targetName =
                                  item.details?.targetAgentName ?? targetInfo?.name ?? "agent"
                                return (
                                  <View
                                    style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
                                  >
                                    <Avatar
                                      name={targetName}
                                      imageUrl={targetInfo?.avatarUrl}
                                      size={16}
                                      isAgent
                                    />
                                    <T step="sm" tone="text2">
                                      {targetName}
                                    </T>
                                  </View>
                                )
                              })()}
                            {verb.fromBadge && <MovementBadge label={verb.fromBadge.label} />}
                            {verb.fromBadge && verb.toBadge && (
                              <Ph name="arrow-right" size={11} color={c.text3} />
                            )}
                            {verb.toBadge && <MovementBadge label={verb.toBadge.label} />}
                          </View>
                          {/* Task title as context */}
                          <T step="12" tone="text3" numberOfLines={2}>
                            {item.taskTitle}
                          </T>
                          {/* Expandable note text for progress notes */}
                          {item.eventType === "progress_note" && item.noteText && (
                            <NoteText text={item.noteText} />
                          )}
                        </View>
                        {/* Action links + event colour dot */}
                        <View
                          style={{
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 8,
                            paddingTop: 4,
                          }}
                        >
                          {item.channelId && onOpenConversation ? (
                            <Pressable
                              accessibilityRole="button"
                              onPress={() => onOpenConversation(item.channelId!)}
                              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                              style={
                                Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined
                              }
                            >
                              <Ph name="chat-circle" size={13} color={c.accent} />
                            </Pressable>
                          ) : null}
                          <Dot color={verb.color} size={8} />
                        </View>
                      </LRow>
                    )
                  }),
                ])}
              </LGroup>
            )}
          </View>
        </View>

        {/* ═══ RIGHT COLUMN ═══ */}
        <View style={columnStyle(1)}>
          {/* Burn chart */}
          <Card pad>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <Ph name="chart-line-up" size={14} color={c.accent} />
              <T step="xs" tone="text2">
                {t("board.statusBurnChart")}
              </T>
            </View>
            <BurnChart points={burnupPoints} />
          </Card>

          {/* Team */}
          <View>
            <SectionLabel
              label={t("board.mission.team", { defaultValue: "Team" })}
              count={teamMembers.length}
            />
            {teamMembers.length === 0 ? (
              <EmptyHint>
                {t("board.mission.teamEmpty", { defaultValue: "No agents on this project yet." })}
              </EmptyHint>
            ) : (
              <LGroup>
                {teamMembers.map((member) => {
                  // Split tasks: active (non-done, non-backlog), backlog, and done
                  const activeTasks = member.tasks.filter(
                    (t) => t.columnSlug !== "done" && t.columnSlug !== "backlog",
                  )
                  const backlogTasks = member.tasks.filter((t) => t.columnSlug === "backlog")
                  const doneTasks = member.tasks.filter((t) => t.columnSlug === "done")
                  const now = Date.now()
                  const RECENT_MS = 30 * 60 * 1000
                  const recentDone = doneTasks.filter(
                    (task) => now - new Date(task.updatedAt).getTime() < RECENT_MS,
                  )
                  const restCount = doneTasks.length - recentDone.length
                  const hasTasks =
                    activeTasks.length > 0 || backlogTasks.length > 0 || doneTasks.length > 0
                  return (
                    <LRow
                      key={member.id}
                      padV={12}
                      style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}
                    >
                      {/* Member row */}
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                        <Avatar
                          name={member.name}
                          imageUrl={member.avatarUrl}
                          size={28}
                          isAgent={member.type === "agent"}
                          status={
                            member.type === "agent" ? (member.isWorking ? "busy" : "live") : "live"
                          }
                        />
                        <View
                          style={{
                            flex: 1,
                            minWidth: 0,
                            flexDirection: "row",
                            alignItems: "baseline",
                            gap: 6,
                          }}
                        >
                          <T step="sm" ellipsis style={{ flexShrink: 1 }}>
                            {member.name}
                          </T>
                          <T step="12" tone="text3">
                            ·{" "}
                            {member.type === "agent"
                              ? t("board.mission.roleAgent", { defaultValue: "Agent" })
                              : t("board.mission.roleHuman", { defaultValue: "Human" })}
                          </T>
                        </View>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                          <Dot
                            color={
                              member.isWorking
                                ? COL_COLORS.in_progress
                                : member.type === "human"
                                  ? HUMAN_COLOR
                                  : c.text3
                            }
                            size={6}
                          />
                          <T step="codenote" tone="text3">
                            {member.isWorking
                              ? t("board.mission.working", { defaultValue: "Working" })
                              : t("board.mission.idle", { defaultValue: "Idle" })}
                          </T>
                        </View>
                      </View>

                      {hasTasks ? (
                        <View style={{ paddingLeft: 38, gap: 1 }}>
                          {/* Active tasks (non-done, non-backlog, including running) */}
                          {activeTasks.map((task) => (
                            <TeamTaskRow
                              key={task.taskId}
                              title={task.title}
                              color={COL_COLORS[task.columnSlug] || MUTED}
                              running={task.running}
                              when={timeAgoNatural(task.updatedAt, locale)}
                              onPress={() => onOpenTask?.(task.taskId)}
                            />
                          ))}

                          {/* Backlog tasks — collapsed summary */}
                          {backlogTasks.length > 0 && (
                            <View
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 8,
                                paddingVertical: 5,
                              }}
                            >
                              <Dot color={COL_COLORS.backlog} size={6} />
                              <T step="12" tone="text3">
                                {t("board.mission.backlogCount", {
                                  count: backlogTasks.length,
                                  defaultValue: "{{count}} tasks in backlog",
                                })}
                              </T>
                            </View>
                          )}

                          {/* Done tasks — recently completed (last 30 min) individually, rest collapsed */}
                          {recentDone.map((task) => (
                            <TeamTaskRow
                              key={task.taskId}
                              title={task.title}
                              color={COL_COLORS.done}
                              when={timeAgoNatural(task.updatedAt, locale)}
                              onPress={() => onOpenTask?.(task.taskId)}
                            />
                          ))}
                          {restCount > 0 && (
                            <View
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                gap: 8,
                                paddingVertical: 5,
                              }}
                            >
                              <Dot color={COL_COLORS.done} size={6} />
                              <T step="12" tone="text3">
                                {t("board.mission.doneCount", {
                                  count: restCount,
                                  defaultValue: "+{{count}} completed tasks",
                                })}
                              </T>
                            </View>
                          )}
                        </View>
                      ) : null}
                    </LRow>
                  )
                })}
              </LGroup>
            )}
          </View>
        </View>
      </View>
    </Page>
  )
}
