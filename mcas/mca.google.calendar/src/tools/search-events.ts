import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { type CuratedEvent, extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit, wrapCalendarCall } from "./utils"

export const searchEvents: ToolConfig = {
  description:
    "Search events by free-text query (matches title, description, location, attendees). Returns curated rows with full attendee/organizer/recurrence/Meet details. Params: query, calendarId?, startDate?, endDate?, limit (1-2500, def 25), cursor, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free text query." },
      calendarId: {
        type: "string",
        description: 'Calendar ID. Defaults to "primary".',
      },
      startDate: {
        type: "string",
        description: "Optional lower bound (inclusive) ISO 8601.",
      },
      endDate: {
        type: "string",
        description: "Optional upper bound (exclusive) ISO 8601.",
      },
      limit: {
        type: "number",
        description: "Max events per page. Min 1, max 2500, default 25.",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor (Google events nextPageToken).",
      },
      eventTypes: {
        type: "array",
        items: {
          type: "string",
          enum: ["default", "focusTime", "outOfOffice", "workingLocation", "birthday", "fromGmail"],
        },
        description: "Optional filter by event type.",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist per row.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Google response. Default false.",
      },
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { query, calendarId, startDate, endDate, limit, cursor, eventTypes, fields, includeRaw } =
      args as {
        query: string
        calendarId?: string
        startDate?: string
        endDate?: string
        limit?: number
        cursor?: string
        eventTypes?: string[]
        fields?: string[]
        includeRaw?: boolean
      }
    const maxResults = sanitizeLimit(limit, { max: 2500, default: 25 })

    const response = await wrapCalendarCall(() =>
      calendar.events.list({
        calendarId: calendarId ?? "primary",
        q: query,
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
        ...(startDate ? { timeMin: startDate } : {}),
        ...(endDate ? { timeMax: endDate } : {}),
        ...(cursor ? { pageToken: cursor } : {}),
        ...(eventTypes && eventTypes.length > 0 ? { eventTypes } : {}),
      }),
    )

    const rawItems = response.data.items ?? []
    const shaped: CuratedEvent[] = rawItems.map(extractEventShape)
    const events = resolveFieldsList(
      shaped as unknown as Array<Record<string, unknown>>,
      rawItems,
      { includeRaw, fields, defaultFields: EVENT_FIELDS },
    )

    return {
      account: email,
      calendarId: calendarId ?? "primary",
      query,
      events,
      total: events.length,
      hasMore: Boolean(response.data.nextPageToken),
      nextCursor: response.data.nextPageToken ?? null,
    }
  },
}
