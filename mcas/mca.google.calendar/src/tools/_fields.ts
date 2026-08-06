/**
 * Default whitelists exposed by tools when caller does not pass `fields`.
 *
 * Critical: any field the renderer needs must live here. Removing a field
 * silently breaks the renderer (logos disappear, chips show initials, etc.).
 * See feedback_mca_common_gotchas.md.
 */

export type FieldList = readonly string[]

export const EVENT_FIELDS = [
  "id",
  "summary",
  "description",
  "location",
  "status",
  "start",
  "end",
  "allDay",
  "timeZone",
  "colorId",
  "attendees",
  "organizer",
  "creator",
  "recurrence",
  "recurrenceDescription",
  "recurringEventId",
  "conferenceData",
  "hangoutLink",
  "htmlLink",
  "sequence",
  "updated",
  "created",
  // Sprint 4: eventTypes especializados (focusTime, outOfOffice, workingLocation,
  // birthday, fromGmail) + attachments + transparency/visibility/iCalUID.
  "eventType",
  "focusTimeProperties",
  "outOfOfficeProperties",
  "workingLocationProperties",
  "attachments",
  "transparency",
  "visibility",
  "iCalUID",
] as const satisfies FieldList

export const CALENDAR_FIELDS = [
  "id",
  "summary",
  "description",
  "timeZone",
  "primary",
  "selected",
  "accessRole",
  "backgroundColor",
  "foregroundColor",
  "colorId",
] as const satisfies FieldList

export const FREE_BUSY_FIELDS = ["calendarId", "busy", "errors"] as const satisfies FieldList

// Sprint 4 — Settings, Colors, Instances whitelists.

export const SETTINGS_FIELDS = ["id", "value", "etag", "kind"] as const satisfies FieldList

export const COLORS_FIELDS = ["kind", "updated", "calendar", "event"] as const satisfies FieldList

/** Instances inherit EVENT_FIELDS plus override metadata. */
export const INSTANCE_FIELDS = [...EVENT_FIELDS, "originalStartTime"] as const satisfies FieldList
