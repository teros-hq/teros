import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { type CuratedEvent, extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit, wrapCalendarCall } from "./utils"

const VALID_EVENT_TYPES = [
  "default",
  "focusTime",
  "outOfOffice",
  "workingLocation",
  "birthday",
  "fromGmail",
] as const

interface ListEventsArgs {
  startDate?: string
  endDate?: string
  calendarId?: string
  limit?: number
  cursor?: string
  timeZone?: string
  eventTypes?: string[]
  syncToken?: string
  fields?: string[]
  includeRaw?: boolean
}

export const listEvents: ToolConfig = {
  description:
    "List events in a date range. Returns curated rows with attendee responseStatus, organizer, colorId, htmlLink, hangoutLink, recurrence, eventType, and Sprint-4 specialized properties when applicable. Supports filtering by `eventTypes` (default | focusTime | outOfOffice | workingLocation | birthday | fromGmail) and incremental sync via `syncToken`. NOTE: when `syncToken` is passed, startDate/endDate/eventTypes are exclusive — they will trigger an error from Google.",
  parameters: {
    type: "object",
    properties: {
      startDate: {
        type: "string",
        description:
          'Lower bound (inclusive) ISO 8601, e.g. "2026-04-28T00:00:00Z". Required unless using `syncToken`.',
      },
      endDate: {
        type: "string",
        description:
          'Upper bound (exclusive) ISO 8601, e.g. "2026-04-29T00:00:00Z". Required unless using `syncToken`.',
      },
      calendarId: { type: "string", description: 'Calendar ID. Defaults to "primary".' },
      limit: { type: "number", description: "Max events per page. Min 1, max 2500, default 25." },
      cursor: { type: "string", description: "Pagination cursor (Google events nextPageToken)." },
      timeZone: {
        type: "string",
        description: 'IANA timezone (e.g. "Europe/Madrid"). Default: calendar timezone.',
      },
      eventTypes: {
        type: "array",
        items: {
          type: "string",
          enum: ["default", "focusTime", "outOfOffice", "workingLocation", "birthday", "fromGmail"],
        },
        description:
          'Filter by event type. E.g. ["outOfOffice"] to list only OOO. Mutually exclusive with `syncToken`.',
      },
      syncToken: {
        type: "string",
        description:
          "Token returned as `nextSyncToken` from a previous call. When passed, only events that changed since are returned (incremental sync). EXCLUSIVE with startDate/endDate/eventTypes.",
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as ListEventsArgs
    const maxResults = sanitizeLimit(a.limit, { max: 2500, default: 25 })

    if (a.syncToken && (a.startDate || a.endDate || (a.eventTypes && a.eventTypes.length > 0))) {
      throw new Error(
        "syncToken is exclusive with startDate/endDate/eventTypes. Drop the time-range and eventTypes filters when using syncToken; the API would otherwise return 410 Gone.",
      )
    }
    if (!a.syncToken && (!a.startDate || !a.endDate)) {
      throw new Error("startDate and endDate are required (unless using syncToken).")
    }
    if (a.eventTypes) {
      const invalid = a.eventTypes.filter(
        (t) => !(VALID_EVENT_TYPES as readonly string[]).includes(t),
      )
      if (invalid.length > 0) {
        throw new Error(
          `Invalid eventTypes: ${invalid.join(", ")}. Valid: ${VALID_EVENT_TYPES.join(", ")}.`,
        )
      }
    }

    const response = await wrapCalendarCall(() =>
      calendar.events.list({
        calendarId: a.calendarId ?? "primary",
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
        ...(a.syncToken
          ? { syncToken: a.syncToken }
          : {
              timeMin: a.startDate,
              timeMax: a.endDate,
              ...(a.eventTypes && a.eventTypes.length > 0 ? { eventTypes: a.eventTypes } : {}),
            }),
        ...(a.cursor ? { pageToken: a.cursor } : {}),
        ...(a.timeZone ? { timeZone: a.timeZone } : {}),
      }),
    )

    const rawItems = response.data.items ?? []
    const shaped: CuratedEvent[] = rawItems.map(extractEventShape)
    const events = resolveFieldsList(
      shaped as unknown as Array<Record<string, unknown>>,
      rawItems,
      { includeRaw: a.includeRaw, fields: a.fields, defaultFields: EVENT_FIELDS },
    )

    return {
      account: email,
      calendarId: a.calendarId ?? "primary",
      events,
      total: events.length,
      hasMore: Boolean(response.data.nextPageToken),
      nextCursor: response.data.nextPageToken ?? null,
      nextSyncToken: response.data.nextSyncToken ?? null,
    }
  },
}
