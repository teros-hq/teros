/**
 * Shape extractors that turn Google API objects into curated, renderer-ready
 * payloads. The renderer never sees raw API shape — it relies on these
 * camelCase outputs.
 */

import type { calendar_v3 } from "googleapis"
import { computeDurationMinutes, describeRecurrence, flattenEventTime } from "../lib"

export interface CuratedAttendee {
  email: string
  displayName?: string
  responseStatus?: string
  organizer?: boolean
  optional?: boolean
  self?: boolean
  comment?: string
}

export interface CuratedPerson {
  email?: string
  displayName?: string
  self?: boolean
}

export interface CuratedConference {
  type?: string
  conferenceId?: string
  entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>
}

export interface CuratedFocusTimeProperties {
  autoDeclineMode?: string
  chatStatus?: string
  declineMessage?: string
}

export interface CuratedOutOfOfficeProperties {
  autoDeclineMode?: string
  declineMessage?: string
}

export interface CuratedWorkingLocationProperties {
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

export interface CuratedAttachment {
  fileUrl: string
  title?: string
  mimeType?: string
  iconLink?: string
  fileId?: string
}

export type EventTypeName =
  | "default"
  | "focusTime"
  | "outOfOffice"
  | "workingLocation"
  | "birthday"
  | "fromGmail"

export interface CuratedEvent {
  id?: string
  summary?: string
  description?: string
  location?: string
  status?: string
  start: string | null
  end: string | null
  allDay: boolean
  timeZone?: string
  colorId?: string
  attendees?: CuratedAttendee[]
  organizer?: CuratedPerson
  creator?: CuratedPerson
  recurrence?: string[]
  recurrenceDescription?: string | null
  recurringEventId?: string
  conferenceData?: CuratedConference
  hangoutLink?: string
  htmlLink?: string
  sequence?: number
  updated?: string
  created?: string
  /** Sprint 4 extensions. */
  eventType?: EventTypeName
  focusTimeProperties?: CuratedFocusTimeProperties
  outOfOfficeProperties?: CuratedOutOfOfficeProperties
  workingLocationProperties?: CuratedWorkingLocationProperties
  attachments?: CuratedAttachment[]
  transparency?: string
  visibility?: string
  iCalUID?: string
  /** Only present on instance entries returned by `events.instances`. */
  originalStartTime?: string | null
}

export interface CuratedSetting {
  id: string
  value: string
}

export interface CuratedColors {
  kind?: string
  updated?: string
  event?: Record<string, { background?: string; foreground?: string }>
  calendar?: Record<string, { background?: string; foreground?: string }>
}

export interface CuratedCalendar {
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

export interface CuratedBusySlot {
  startISO: string
  endISO: string
  durationMinutes: number
}

export interface CuratedFreeBusy {
  calendarId: string
  busy: CuratedBusySlot[]
  errors?: Array<{ domain?: string; reason?: string }>
}

export function extractEventShape(raw: calendar_v3.Schema$Event): CuratedEvent {
  const start = flattenEventTime(raw.start)
  const end = flattenEventTime(raw.end)
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime)
  const recurrenceDescription = describeRecurrence(raw.recurrence ?? null)
  const eventType = (raw.eventType ?? "default") as EventTypeName
  return stripUndefined({
    id: raw.id ?? undefined,
    summary: raw.summary ?? undefined,
    description: raw.description ?? undefined,
    location: raw.location ?? undefined,
    status: raw.status ?? undefined,
    start,
    end,
    allDay,
    timeZone: raw.start?.timeZone ?? raw.end?.timeZone ?? undefined,
    colorId: raw.colorId ?? undefined,
    attendees: raw.attendees ? raw.attendees.map(extractAttendee) : undefined,
    organizer: raw.organizer ? extractPerson(raw.organizer) : undefined,
    creator: raw.creator ? extractPerson(raw.creator) : undefined,
    recurrence: raw.recurrence ?? undefined,
    recurrenceDescription,
    recurringEventId: raw.recurringEventId ?? undefined,
    conferenceData: raw.conferenceData ? extractConference(raw.conferenceData) : undefined,
    hangoutLink: raw.hangoutLink ?? undefined,
    htmlLink: raw.htmlLink ?? undefined,
    sequence: typeof raw.sequence === "number" ? raw.sequence : undefined,
    updated: raw.updated ?? undefined,
    created: raw.created ?? undefined,
    eventType,
    focusTimeProperties: raw.focusTimeProperties
      ? extractFocusTimeProperties(raw.focusTimeProperties)
      : undefined,
    outOfOfficeProperties: raw.outOfOfficeProperties
      ? extractOutOfOfficeProperties(raw.outOfOfficeProperties)
      : undefined,
    workingLocationProperties: raw.workingLocationProperties
      ? extractWorkingLocationProperties(raw.workingLocationProperties)
      : undefined,
    attachments: raw.attachments ? raw.attachments.map(extractAttachment) : undefined,
    transparency: raw.transparency ?? undefined,
    visibility: raw.visibility ?? undefined,
    iCalUID: raw.iCalUID ?? undefined,
    originalStartTime: raw.originalStartTime ? flattenEventTime(raw.originalStartTime) : undefined,
  })
}

export function extractFocusTimeProperties(
  raw: calendar_v3.Schema$EventFocusTimeProperties,
): CuratedFocusTimeProperties {
  return stripUndefined({
    autoDeclineMode: raw.autoDeclineMode ?? undefined,
    chatStatus: raw.chatStatus ?? undefined,
    declineMessage: raw.declineMessage ?? undefined,
  })
}

export function extractOutOfOfficeProperties(
  raw: calendar_v3.Schema$EventOutOfOfficeProperties,
): CuratedOutOfOfficeProperties {
  return stripUndefined({
    autoDeclineMode: raw.autoDeclineMode ?? undefined,
    declineMessage: raw.declineMessage ?? undefined,
  })
}

export function extractWorkingLocationProperties(
  raw: calendar_v3.Schema$EventWorkingLocationProperties,
): CuratedWorkingLocationProperties {
  const officeLocation = raw.officeLocation
    ? stripUndefined({
        buildingId: raw.officeLocation.buildingId ?? undefined,
        deskId: raw.officeLocation.deskId ?? undefined,
        floorId: raw.officeLocation.floorId ?? undefined,
        floorSectionId: raw.officeLocation.floorSectionId ?? undefined,
        label: raw.officeLocation.label ?? undefined,
      })
    : undefined
  const customLocation = raw.customLocation
    ? stripUndefined({ label: raw.customLocation.label ?? undefined })
    : undefined
  return stripUndefined({
    type: raw.type ?? undefined,
    homeOffice: raw.homeOffice ?? undefined,
    officeLocation,
    customLocation,
  })
}

export function extractAttachment(raw: calendar_v3.Schema$EventAttachment): CuratedAttachment {
  return stripUndefined({
    fileUrl: raw.fileUrl ?? "",
    title: raw.title ?? undefined,
    mimeType: raw.mimeType ?? undefined,
    iconLink: raw.iconLink ?? undefined,
    fileId: raw.fileId ?? undefined,
  }) as CuratedAttachment
}

export function extractSettingShape(raw: calendar_v3.Schema$Setting): CuratedSetting {
  return {
    id: raw.id ?? "",
    value: raw.value ?? "",
  }
}

export function extractColorsShape(raw: calendar_v3.Schema$Colors): CuratedColors {
  const event: CuratedColors["event"] = {}
  for (const [id, def] of Object.entries(raw.event ?? {})) {
    event[id] = stripUndefined({
      background: def.background ?? undefined,
      foreground: def.foreground ?? undefined,
    })
  }
  const calendar: CuratedColors["calendar"] = {}
  for (const [id, def] of Object.entries(raw.calendar ?? {})) {
    calendar[id] = stripUndefined({
      background: def.background ?? undefined,
      foreground: def.foreground ?? undefined,
    })
  }
  return stripUndefined({
    kind: raw.kind ?? undefined,
    updated: raw.updated ?? undefined,
    event,
    calendar,
  })
}

export function extractAttendee(raw: calendar_v3.Schema$EventAttendee): CuratedAttendee {
  return stripUndefined({
    email: raw.email ?? "",
    displayName: raw.displayName ?? undefined,
    responseStatus: raw.responseStatus ?? undefined,
    organizer: raw.organizer ?? undefined,
    optional: raw.optional ?? undefined,
    self: raw.self ?? undefined,
    comment: raw.comment ?? undefined,
  }) as CuratedAttendee
}

export function extractPerson(
  raw: calendar_v3.Schema$Event["organizer"] | calendar_v3.Schema$Event["creator"],
): CuratedPerson {
  return stripUndefined({
    email: raw?.email ?? undefined,
    displayName: raw?.displayName ?? undefined,
    self: raw?.self ?? undefined,
  })
}

function extractConference(raw: calendar_v3.Schema$ConferenceData): CuratedConference {
  return stripUndefined({
    type: raw.conferenceSolution?.key?.type ?? undefined,
    conferenceId: raw.conferenceId ?? undefined,
    entryPoints: raw.entryPoints?.map((ep) =>
      stripUndefined({
        entryPointType: ep.entryPointType ?? undefined,
        uri: ep.uri ?? undefined,
        label: ep.label ?? undefined,
      }),
    ) as CuratedConference["entryPoints"],
  })
}

export function extractCalendarShape(raw: calendar_v3.Schema$CalendarListEntry): CuratedCalendar {
  return stripUndefined({
    id: raw.id ?? undefined,
    summary: raw.summary ?? undefined,
    description: raw.description ?? undefined,
    timeZone: raw.timeZone ?? undefined,
    primary: raw.primary ?? undefined,
    selected: raw.selected ?? undefined,
    accessRole: raw.accessRole ?? undefined,
    backgroundColor: raw.backgroundColor ?? undefined,
    foregroundColor: raw.foregroundColor ?? undefined,
    colorId: raw.colorId ?? undefined,
  })
}

export function extractFreeBusy(
  calendarId: string,
  raw: calendar_v3.Schema$FreeBusyCalendar | undefined,
): CuratedFreeBusy {
  const busy = (raw?.busy ?? []).map((slot) => {
    const startISO = slot.start ?? ""
    const endISO = slot.end ?? ""
    return {
      startISO,
      endISO,
      durationMinutes: computeDurationMinutes(startISO, endISO),
    }
  })
  const errors = raw?.errors?.map((e) =>
    stripUndefined({ domain: e.domain ?? undefined, reason: e.reason ?? undefined }),
  )
  return stripUndefined({ calendarId, busy, errors }) as CuratedFreeBusy
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}
