/**
 * Google Calendar — constants, tolerant types, data helpers, prop factories.
 *
 * Zero local components. Global primitives (`IconChip`, `IconTile`, `PillList`,
 * `ResourceCard`, `EntityRow`, `ActionBadge`, `ToolCallCard`, `Avatar`,
 * `KeyValueGrid`, ...) cover every Calendar-specific UI case through props.
 *
 * What lives here:
 *  - `CALENDAR_ICON` (logo url) + `EVENT_COLORS` + `RSVP_COLORS` + `MEET_COLOR`.
 *  - Tolerant tipos (`CalendarEvent`, `CalendarRef`, `Attendee`, etc.) que aceptan
 *    el shape curado del backend post TER-222 y degradan suave si faltan campos.
 *  - Data helpers: `formatEventTime`, `getMyAttendee`, `parseRecurrence` (the
 *    backend already ships `recurrenceDescription` parsed, but we have a fallback
 *    in case it's missing on legacy payloads).
 *  - **Prop factories** que se pasan a primitivos globales:
 *      `eventColorChipProps(colorId, summary) → { icon, accent, text }`
 *      `rsvpChipProps(responseStatus)`
 *      `meetChipProps()`
 *      `attendeeChipProps(attendee)` and `calendarTileProps(calendar)`.
 *  - Generic `unwrap` / `unwrapList` (parity with Linear).
 *  - `useScrollStyle(maxHeight)` for the theme-aware thin web scrollbar (RN-Web-only).
 *  - `TOOL_LABELS` map and `getToolLabel` lookup.
 */

import type React from "react"
import { useTranslation } from "react-i18next"
import {
  Badge,
  Brain,
  Building2,
  Cake,
  Calendar,
  CheckCircle2,
  CircleHelp,
  Clock,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  colors as globalColors,
  Home,
  Mail,
  MapPin,
  MinusCircle,
  Plane,
  Presentation,
  ToolCallCard,
  useColors,
  useMcaTheme,
  Video,
  XCircle,
} from "../../primitives"
import type { ToolCallRendererProps } from "../../types"

// ============================================================================
// Brand identity — logo + official Google Calendar palette
// ============================================================================

/**
 * Logo oficial servido por el backend. Pasarlo al `iconUri` de
 * `<ToolCallCard/>` para reconocimiento visual inmediato.
 */
export const CALENDAR_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.google.calendar/icon.png`

/**
 * Los 11 colores oficiales de Google Calendar. Hex validados contra la UI
 * del producto (color picker en la web app). El backend devuelve `colorId`
 * como string '1'..'11'; mapear con este record. Fallback a `COLOR_DEFAULT`
 * (Google Blue) cuando no hay colorId.
 *
 * IMPORTANTE: No usar tokens Tailwind defaults (`#3b82f6` etc.) — son
 * incorrectos. Ej: Calendar "Banana" es amarillo `#F6BF26`, no el típico
 * `#fbbf24` de Tailwind.
 */
export const EVENT_COLORS: Record<string, string> = {
  "1": "#7986CB", // Lavender
  "2": "#33B679", // Sage
  "3": "#8E24AA", // Grape
  "4": "#E67C73", // Flamingo
  "5": "#F6BF26", // Banana
  "6": "#F4511E", // Tangerine
  "7": "#039BE5", // Peacock
  "8": "#616161", // Graphite
  "9": "#3F51B5", // Blueberry
  "10": "#0B8043", // Basil
  "11": "#D50000", // Tomato
}
export const COLOR_DEFAULT = "#1A73E8" // Google Blue
export const MEET_COLOR = "#1A73E8" // Google Meet brand uses the same blue

/**
 * Palette para el RSVP status del attendee. Validada contra los chips de la
 * UI de Google Calendar (la página del evento muestra accepted/declined con
 * estos verdes/rojos).
 */
export const RSVP_COLORS: Record<string, string> = {
  accepted: "#0B8043", // Basil green
  declined: "#D50000", // Tomato red
  tentative: "#F6BF26", // Banana yellow
  needsAction: globalColors.text3, // Neutral gray (theme-adaptive)
}

const RSVP_LABELS: Record<string, string> = {
  accepted: "Accepted",
  declined: "Declined",
  tentative: "Tentative",
  needsAction: "Pending",
}

// ============================================================================
// Tolerant tipos (curated post-TER-222 + legacy fallback)
// ============================================================================

export interface CalendarPerson {
  email?: string
  displayName?: string
  self?: boolean
}

export interface CalendarAttendee extends CalendarPerson {
  responseStatus?: string
  organizer?: boolean
  optional?: boolean
  comment?: string
}

export interface CalendarConference {
  type?: string
  conferenceId?: string
  entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>
}

export interface CalendarEvent {
  id?: string
  summary?: string
  description?: string
  location?: string
  status?: string
  start?: string | null
  end?: string | null
  allDay?: boolean
  timeZone?: string
  colorId?: string
  attendees?: CalendarAttendee[]
  organizer?: CalendarPerson
  creator?: CalendarPerson
  recurrence?: string[]
  recurrenceDescription?: string | null
  recurringEventId?: string
  conferenceData?: CalendarConference
  hangoutLink?: string
  htmlLink?: string
  sequence?: number
  updated?: string
  created?: string
  /** Sprint 4 — eventType + specialized properties + attachments. */
  eventType?: string
  focusTimeProperties?: FocusTimeProperties
  outOfOfficeProperties?: OutOfOfficeProperties
  workingLocationProperties?: WorkingLocationProperties
  attachments?: CalendarAttachment[]
  transparency?: string
  visibility?: string
  iCalUID?: string
  /** Only on instances returned by `events.instances`. */
  originalStartTime?: string | null
}

export interface CalendarRef {
  id?: string
  summary?: string
  description?: string
  timeZone?: string
  primary?: boolean
  selected?: boolean
  accessRole?: string
  backgroundColor?: string
  foregroundColor?: string
  colorId?: string
}

export interface FreeBusySlot {
  startISO: string
  endISO: string
  durationMinutes: number
}

export interface FreeBusyRow {
  calendarId: string
  busy: FreeBusySlot[]
  errors?: Array<{ domain?: string; reason?: string }>
}

// ============================================================================
// Tool labels + name helpers
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  "-health-check": "mca.toolCall.healthCheck",
  "calendar-list-calendars": "Calendars",
  "calendar-list-events": "Events",
  "calendar-get-event": "mca.toolCall.eventDetails",
  "calendar-search-events": "mca.toolCall.eventSearch",
  "calendar-create-event": "mca.toolCall.createEvent",
  "calendar-update-event": "mca.toolCall.updateEvent",
  "calendar-delete-event": "mca.toolCall.deleteEvent",
  "calendar-get-free-busy": "Free / busy",
  "calendar-respond-to-event": "RSVP",
  "calendar-quick-add-event": "Quick add event",
  // Sprint 4
  "calendar-create-focus-time": "mca.toolCall.focusTime",
  "calendar-create-out-of-office": "Out of office",
  "calendar-set-working-location": "mca.toolCall.workingLocation",
  "calendar-get-settings": "mca.toolCall.calendarSettings",
  "calendar-get-colors": "mca.toolCall.calendarColors",
  "calendar-move-event": "mca.toolCall.moveEvent",
  "calendar-import-event": "mca.toolCall.importEvent",
  "calendar-list-instances": "mca.toolCall.eventInstances",
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split("_")
  return parts[parts.length - 1] || toolName
}

function humanize(name: string): string {
  const cleaned = name.startsWith("calendar-") ? name.slice("calendar-".length) : name
  return cleaned
    .split("-")
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(" ")
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName)
  return TOOL_LABELS[short] ?? humanize(short)
}

// ============================================================================
// Status adapters (parity with Linear)
// ============================================================================

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
// Web-only thin scrollbar
// ============================================================================

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useColors()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-only scrollbar props
export function useScrollStyle(maxHeight: number): any {
  const c = useColors()
  const theme = useMcaTheme()
  const isDark = theme === "dark"
  return {
    maxHeight,
    scrollbarWidth: "thin",
    scrollbarColor: `${isDark ? "rgba(255,255,255,0.2)" : c.borderStrong} transparent`,
  }
}

/** @deprecated Use `useScrollStyle(maxHeight)` inside a component for theme-aware scrollbars. */
export function scrollStyle(maxHeight: number) {
  return {
    maxHeight,
    scrollbarWidth: "thin",
    scrollbarColor: "rgba(255,255,255,0.2) transparent",
    // biome-ignore lint/suspicious/noExplicitAny: web-only style merge
  } as any
}

// ============================================================================
// Tolerant unwrap helpers (parity with Linear)
// ============================================================================

export function unwrap<T>(parsed: unknown, wrapperKey: string): T | null {
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const wrapped = obj[wrapperKey]
  if (wrapped && typeof wrapped === "object") return wrapped as T
  return null
}

export function unwrapList<T>(
  parsed: unknown,
  wrapperKey: string,
): { items: T[]; nextCursor?: string | null; total?: number; hasMore?: boolean } {
  if (!parsed) return { items: [] }
  if (Array.isArray(parsed)) return { items: parsed as T[] }
  if (typeof parsed !== "object") return { items: [] }
  const obj = parsed as Record<string, unknown>
  const list = obj[wrapperKey]
  const items = Array.isArray(list) ? (list as T[]) : []
  const nextCursor = typeof obj.nextCursor === "string" ? (obj.nextCursor as string) : null
  const total = typeof obj.total === "number" ? (obj.total as number) : undefined
  const hasMore = typeof obj.hasMore === "boolean" ? (obj.hasMore as boolean) : undefined
  return { items, nextCursor, total, hasMore }
}

// ============================================================================
// Data helpers — time, recurrence, attendee picking
// ============================================================================

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const SHORT_MONTHS = [
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

/**
 * Build a one-line phrase for an event's `start–end`. Handles all-day events
 * (no time, just date span) and cross-day events (shows date for the second
 * datetime when it differs from the first).
 *
 * Examples:
 *   "14:00–15:00"                       (same day, today)
 *   "Mon Apr 28 · 09:00–09:30"          (same day, future)
 *   "All day · Mon Apr 28"              (all-day single day)
 *   "All day · Mon Apr 28 → Tue Apr 29" (all-day multi)
 *   "Apr 28 14:00 → Apr 29 09:30"       (cross-day timed)
 */
export function formatEventTime(event: {
  start?: string | null
  end?: string | null
  allDay?: boolean
}): string {
  const { start, end, allDay } = event
  if (!start) return "—"

  if (allDay) {
    const a = formatDateOnly(start)
    if (!end || end === start) return `All day · ${a}`
    const b = formatDateOnly(end)
    if (a === b) return `All day · ${a}`
    return `All day · ${a} → ${b}`
  }

  const startDate = new Date(start)
  if (Number.isNaN(startDate.getTime())) return start

  const endDate = end ? new Date(end) : null
  const sameDay =
    endDate !== null &&
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate()

  if (!endDate) return formatDateTime(startDate)
  if (sameDay) {
    const isToday = sameDayAsToday(startDate)
    const startStr = formatTimeHM(startDate)
    const endStr = formatTimeHM(endDate)
    return isToday
      ? `${startStr}–${endStr}`
      : `${SHORT_DAYS[startDate.getDay()]} ${SHORT_MONTHS[startDate.getMonth()]} ${startDate.getDate()} · ${startStr}–${endStr}`
  }
  return `${formatDateTime(startDate)} → ${formatDateTime(endDate)}`
}

function formatDateOnly(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`
}

function formatDateTime(d: Date): string {
  return `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()} ${formatTimeHM(d)}`
}

function formatTimeHM(d: Date): string {
  const h = d.getHours().toString().padStart(2, "0")
  const m = d.getMinutes().toString().padStart(2, "0")
  return `${h}:${m}`
}

function sameDayAsToday(d: Date): boolean {
  const today = new Date()
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  )
}

/**
 * Format a single ISO timestamp with optional explicit timezone.
 * Ex: `Mon Apr 28 · 14:00 (Europe/Madrid)`.
 */
export function formatTimestampWithZone(iso?: string | null, timeZone?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const base = `${SHORT_DAYS[d.getDay()]} ${SHORT_MONTHS[d.getMonth()]} ${d.getDate()} · ${formatTimeHM(d)}`
  return timeZone ? `${base} (${timeZone})` : base
}

/**
 * Pick the attendee marked as `self`, falling back to email match if backend
 * doesn't expose `self` (legacy shape).
 */
export function getMyAttendee(
  attendees: CalendarAttendee[] | undefined,
  myEmail?: string,
): CalendarAttendee | undefined {
  if (!attendees || attendees.length === 0) return undefined
  const flagged = attendees.find((att) => att.self)
  if (flagged) return flagged
  if (myEmail) {
    const lower = myEmail.toLowerCase()
    return attendees.find((att) => att.email?.toLowerCase() === lower)
  }
  return undefined
}

const FREQ: Record<string, string> = {
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
}
const DAY: Record<string, string> = {
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat",
  SU: "Sun",
}

/**
 * Fallback parser for RRULE strings, used when the backend payload does not
 * carry `recurrenceDescription`. Stays in sync with `mca.google.calendar/src/lib/format.ts`.
 */
export function parseRecurrence(recurrence?: string[] | null): string | null {
  if (!recurrence || recurrence.length === 0) return null
  const phrases = recurrence.map(describeRule).filter((p): p is string => Boolean(p))
  return phrases.length > 0 ? phrases.join("; ") : null
}

function describeRule(rule: string): string | null {
  if (!rule.startsWith("RRULE:")) return rule
  const parts = rule.slice(6).split(";")
  const params = new Map<string, string>()
  for (const part of parts) {
    const [k, v] = part.split("=")
    if (k && v) params.set(k, v)
  }
  const freq = params.get("FREQ")
  if (!freq) return rule
  const label = FREQ[freq] ?? freq
  const interval = params.get("INTERVAL")
  const byDay = params.get("BYDAY")
  const count = params.get("COUNT")
  const until = params.get("UNTIL")
  const seg: string[] = [
    interval && interval !== "1" ? `Every ${interval} ${label.toLowerCase()}` : label,
  ]
  if (byDay)
    seg.push(
      `on ${byDay
        .split(",")
        .map((c) => DAY[c] ?? c)
        .join(", ")}`,
    )
  if (count) seg.push(`for ${count} occurrences`)
  if (until) seg.push(`until ${until}`)
  return seg.join(" ")
}

// ============================================================================
// Prop factories — feed global primitives without local components
// ============================================================================

/**
 * Color tile/chip representing a Google Calendar event tile. Falls back to
 * Google Blue when the backend does not pass a `colorId`.
 */
export function eventColorChipProps(
  colorId?: string,
  summary?: string,
): { icon: React.ReactNode; accent: string; text: string } {
  const accent = (colorId && EVENT_COLORS[colorId]) || COLOR_DEFAULT
  return {
    icon: <Calendar size={9} color={accent} />,
    accent,
    text: summary && summary.length > 0 ? summary : "Event",
  }
}

export function rsvpChipProps(
  responseStatus?: string,
): { icon: React.ReactNode; accent: string; text: string } | null {
  if (!responseStatus) return null
  const accent = RSVP_COLORS[responseStatus] ?? RSVP_COLORS.needsAction
  const text = RSVP_LABELS[responseStatus] ?? responseStatus
  let icon: React.ReactNode
  switch (responseStatus) {
    case "accepted":
      icon = <CheckCircle2 size={9} color={accent} />
      break
    case "declined":
      icon = <XCircle size={9} color={accent} />
      break
    case "tentative":
      icon = <CircleHelp size={9} color={accent} />
      break
    default:
      icon = <MinusCircle size={9} color={accent} />
  }
  return { icon, accent, text }
}

export function meetChipProps(): { icon: React.ReactNode; accent: string; text: string } {
  return { icon: <Video size={9} color={MEET_COLOR} />, accent: MEET_COLOR, text: "Meet" }
}

/**
 * Compact attendee chip — name + RSVP color. Fed into `<IconChip/>`.
 */
export function attendeeChipProps(attendee: CalendarAttendee): {
  icon: React.ReactNode
  accent: string
  text: string
} {
  const status = attendee.responseStatus ?? "needsAction"
  const accent = RSVP_COLORS[status] ?? RSVP_COLORS.needsAction
  const name = attendee.displayName ?? attendee.email ?? "unknown"
  return {
    icon:
      status === "accepted" ? (
        <CheckCircle2 size={9} color={accent} />
      ) : status === "declined" ? (
        <XCircle size={9} color={accent} />
      ) : status === "tentative" ? (
        <CircleHelp size={9} color={accent} />
      ) : (
        <MinusCircle size={9} color={accent} />
      ),
    accent,
    text: attendee.organizer ? `${name} ★` : name,
  }
}

/**
 * `<IconTile/>` props for a calendar item — uses the backend `backgroundColor`
 * (real product color) as accent, the calendar summary's first 2 chars as
 * fallback label, and a calendar icon when no color is present.
 */
export function calendarTileProps(
  calendar: CalendarRef,
  size = 22,
): { accent: string; size: number; label?: string; icon?: React.ReactNode } {
  const accent = calendar.backgroundColor ?? COLOR_DEFAULT
  const label = calendar.summary?.slice(0, 2).toUpperCase()
  return label
    ? { accent, size, label }
    : { accent, size, icon: <Calendar size={Math.round(size * 0.55)} color={accent} /> }
}

/**
 * For event "color stripe" leading tile — same accent rules as the calendar
 * one but defaults to the per-event color, falling back to default Blue.
 */
export function eventLeadingTileProps(
  event: CalendarEvent,
  size = 22,
): { accent: string; size: number; icon: React.ReactNode } {
  const accent = (event.colorId && EVENT_COLORS[event.colorId]) || COLOR_DEFAULT
  const Icon = event.allDay ? Calendar : Clock
  return { accent, size, icon: <Icon size={Math.round(size * 0.5)} color={accent} /> }
}

// ============================================================================
// Sprint 4 — eventType, attachments, working location helpers
// ============================================================================

export type EventType =
  | "default"
  | "focusTime"
  | "outOfOffice"
  | "workingLocation"
  | "birthday"
  | "fromGmail"

/**
 * Palette por eventType para chips. Validada contra la UI de Google Calendar
 * (el color picker del producto). Usar al pintar `eventTypeChipProps`.
 */
export const EVENT_TYPE_COLORS: Record<EventType, string> = {
  default: COLOR_DEFAULT, // #1A73E8 Google Blue
  focusTime: "#9C27B0", // Calendar Grape (focus)
  outOfOffice: "#F4511E", // Calendar Tangerine (OOO)
  workingLocation: "#26A69A", // Sage adaptado (location)
  birthday: "#E91E63", // Pink (birthday)
  fromGmail: "#4285F4", // Gmail Blue
}

const EVENT_TYPE_LABELS: Record<EventType, string> = {
  default: "Event",
  focusTime: "Focus time",
  outOfOffice: "Out of office",
  workingLocation: "Working",
  birthday: "Birthday",
  fromGmail: "From Gmail",
}

export interface FocusTimeProperties {
  autoDeclineMode?: string
  chatStatus?: string
  declineMessage?: string
}

export interface OutOfOfficeProperties {
  autoDeclineMode?: string
  declineMessage?: string
}

export interface WorkingLocationProperties {
  type?: string
  homeOffice?: unknown
  officeLocation?: {
    buildingId?: string
    deskId?: string
    floorId?: string
    floorSectionId?: string
    label?: string
  }
  customLocation?: { label?: string }
}

export interface CalendarAttachment {
  fileUrl: string
  title?: string
  mimeType?: string
  iconLink?: string
  fileId?: string
}

/**
 * Chip que destaca el eventType cuando NO es 'default'. Returns null para
 * 'default' (no se renderiza nada porque el evento típico no necesita chip).
 */
export function eventTypeChipProps(
  eventType?: string,
): { icon: React.ReactNode; accent: string; text: string } | null {
  if (!eventType || eventType === "default") return null
  const type = eventType as EventType
  const accent = EVENT_TYPE_COLORS[type] ?? COLOR_DEFAULT
  const text = EVENT_TYPE_LABELS[type] ?? eventType
  let icon: React.ReactNode
  switch (type) {
    case "focusTime":
      icon = <Brain size={9} color={accent} />
      break
    case "outOfOffice":
      icon = <Plane size={9} color={accent} />
      break
    case "workingLocation":
      icon = <MapPin size={9} color={accent} />
      break
    case "birthday":
      icon = <Cake size={9} color={accent} />
      break
    case "fromGmail":
      icon = <Mail size={9} color={accent} />
      break
    default:
      icon = <Calendar size={9} color={accent} />
  }
  return { icon, accent, text }
}

/**
 * Chip de attachment Drive. El icono se elige por mimeType (Doc, Sheet,
 * Slides, Image, fallback File). Title truncado a 30 chars. El renderer
 * envuelve el chip en un Pressable que abre `fileUrl`.
 */
export function attachmentChipProps(attachment: CalendarAttachment): {
  icon: React.ReactNode
  accent: string
  text: string
} {
  const accent = globalColors.text3 // Neutral gray (theme-adaptive)
  const mime = attachment.mimeType ?? ""
  let icon: React.ReactNode
  if (mime.includes("document")) icon = <FileText size={9} color={accent} />
  else if (mime.includes("spreadsheet")) icon = <FileSpreadsheet size={9} color={accent} />
  else if (mime.includes("presentation")) icon = <Presentation size={9} color={accent} />
  else if (mime.startsWith("image/")) icon = <FileImage size={9} color={accent} />
  else icon = <File size={9} color={accent} />
  const raw = attachment.title ?? attachment.fileUrl
  const text = raw.length > 30 ? `${raw.slice(0, 28)}…` : raw
  return { icon, accent, text }
}

/**
 * Frase humana para working location.
 *  - homeOffice → "Home"
 *  - officeLocation → "Office: <label>"
 *  - customLocation → "Custom: <label>"
 */
export function workingLocationLabel(props?: WorkingLocationProperties): string {
  if (!props?.type) return "Working location"
  if (props.type === "homeOffice") return "Home"
  if (props.type === "officeLocation") {
    const label = props.officeLocation?.label
    return label ? `Office: ${label}` : "Office"
  }
  if (props.type === "customLocation") {
    const label = props.customLocation?.label
    return label ? `Custom: ${label}` : "Custom"
  }
  return props.type
}

/**
 * Icon for the leading IconTile of a working-location event by type.
 */
export function workingLocationIcon(type?: string, color?: string): React.ReactNode {
  const c = color ?? EVENT_TYPE_COLORS.workingLocation
  if (type === "homeOffice") return <Home size={11} color={c} />
  if (type === "officeLocation") return <Building2 size={11} color={c} />
  return <MapPin size={11} color={c} />
}

// ============================================================================
// CalendarToolShell — compose-only wrapper sobre ToolCallCard
// ============================================================================

/**
 * Pre-rellena `iconUri` con el logo Google Calendar + `description` (lookup
 * en `TOOL_LABELS` o humanize) + `badge` derivado del status. Es la única
 * "componente" permitida en `shared.tsx` por el estándar TER-281: compose-only,
 * no duplica primitivos. El resto del shared es helpers + constantes.
 *
 * Patrón equivalente a `LinearToolShell`. Toda sub-renderer envuelve su body
 * con `<CalendarToolShell .../>`, NUNCA con `<ToolCallCard/>` directo —
 * para garantizar identidad de marca consistente.
 */
interface CalendarToolShellProps {
  toolName: string
  status: ToolCallRendererProps["status"]
  duration?: number
  description?: string
  badge?: React.ReactNode
  defaultExpanded?: boolean
  children?: React.ReactNode
}

export function CalendarToolShell({
  toolName,
  status,
  duration,
  description,
  badge,
  defaultExpanded,
  children,
}: CalendarToolShellProps) {
  const { t } = useTranslation()
  const label = getToolLabel(toolName)
  const resolvedLabel = label.startsWith("mca.") ? t(label) : label
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description ?? resolvedLabel}
      duration={duration}
      iconUri={CALENDAR_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  )
}
