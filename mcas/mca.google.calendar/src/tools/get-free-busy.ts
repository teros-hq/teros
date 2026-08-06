import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { type CuratedFreeBusy, extractFreeBusy } from "./_event-helpers"
import { FREE_BUSY_FIELDS } from "./_fields"
import { resolveFieldsList, wrapCalendarCall } from "./utils"

export const getFreeBusy: ToolConfig = {
  description:
    "Check free/busy across one or more calendars. Returns curated rows [{calendarId, busy: [{startISO, endISO, durationMinutes}], errors?}] — never the raw Google envelope. Params: startDate, endDate, calendarIds[], fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      startDate: {
        type: "string",
        description: "Lower bound (inclusive) ISO 8601.",
      },
      endDate: {
        type: "string",
        description: "Upper bound (exclusive) ISO 8601.",
      },
      calendarIds: {
        type: "array",
        items: { type: "string" },
        description: 'Calendar IDs to query. Defaults to ["primary"].',
      },
      timeZone: {
        type: "string",
        description: "IANA timezone for response slots. Default: caller calendar timezone.",
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean", description: "Return raw Google response. Default false." },
    },
    required: ["startDate", "endDate"],
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { startDate, endDate, calendarIds, timeZone, fields, includeRaw } = args as {
      startDate: string
      endDate: string
      calendarIds?: string[]
      timeZone?: string
      fields?: string[]
      includeRaw?: boolean
    }
    const ids = calendarIds && calendarIds.length > 0 ? calendarIds : ["primary"]

    const response = await wrapCalendarCall(() =>
      calendar.freebusy.query({
        requestBody: {
          timeMin: startDate,
          timeMax: endDate,
          ...(timeZone ? { timeZone } : {}),
          items: ids.map((id) => ({ id })),
        },
      }),
    )

    const calendarsRaw = response.data.calendars ?? {}
    const shaped: CuratedFreeBusy[] = ids.map((id) => extractFreeBusy(id, calendarsRaw[id]))
    const calendars = resolveFieldsList(
      shaped as unknown as Array<Record<string, unknown>>,
      ids.map((id) => calendarsRaw[id] ?? {}),
      { includeRaw, fields, defaultFields: FREE_BUSY_FIELDS },
    )

    return {
      account: email,
      timeMin: response.data.timeMin ?? startDate,
      timeMax: response.data.timeMax ?? endDate,
      calendars,
    }
  },
}
