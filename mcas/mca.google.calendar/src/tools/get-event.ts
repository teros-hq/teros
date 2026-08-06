import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, wrapCalendarCall } from "./utils"

export const getEvent: ToolConfig = {
  description:
    "Retrieve a single event by ID with full details (organizer, attendees with responseStatus, recurrence rule + parsed phrase, conferenceData, hangoutLink, htmlLink). Params: eventId, calendarId?, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "The Google event ID." },
      calendarId: {
        type: "string",
        description: 'Calendar ID. Defaults to "primary".',
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist.",
      },
      includeRaw: {
        type: "boolean",
        description: "Return raw Google response. Default false.",
      },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { eventId, calendarId, fields, includeRaw } = args as {
      eventId: string
      calendarId?: string
      fields?: string[]
      includeRaw?: boolean
    }

    const response = await wrapCalendarCall(() =>
      calendar.events.get({
        calendarId: calendarId ?? "primary",
        eventId,
      }),
    )
    const raw = response.data
    const shape = extractEventShape(raw)
    const event = resolveFields(shape as unknown as Record<string, unknown>, raw, {
      includeRaw,
      fields,
      defaultFields: EVENT_FIELDS,
    })

    return {
      account: email,
      calendarId: calendarId ?? "primary",
      event,
    }
  },
}
