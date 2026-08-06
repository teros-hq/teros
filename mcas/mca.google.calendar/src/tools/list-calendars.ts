import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { type CuratedCalendar, extractCalendarShape } from "./_event-helpers"
import { CALENDAR_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit, wrapCalendarCall } from "./utils"

export const listCalendars: ToolConfig = {
  description:
    "List the user calendars (primary, secondary, shared). Returns curated rows { id, summary, timeZone, primary, accessRole, backgroundColor, ... }. Params: limit (1-250, def 100), cursor, fields?, includeRaw.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max calendars per page. Min 1, max 250, default 100.",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor (Google calendarList nextPageToken).",
      },
      showHidden: {
        type: "boolean",
        description: "Include hidden calendars. Default false.",
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
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { limit, cursor, showHidden, fields, includeRaw } = args as {
      limit?: number
      cursor?: string
      showHidden?: boolean
      fields?: string[]
      includeRaw?: boolean
    }
    const maxResults = sanitizeLimit(limit, { max: 250, default: 100 })

    const response = await wrapCalendarCall(() =>
      calendar.calendarList.list({
        maxResults,
        showHidden: showHidden ?? false,
        ...(cursor ? { pageToken: cursor } : {}),
      }),
    )

    const rawItems = response.data.items ?? []
    const shaped: CuratedCalendar[] = rawItems.map(extractCalendarShape)
    const calendars = resolveFieldsList(
      shaped as unknown as Array<Record<string, unknown>>,
      rawItems,
      { includeRaw, fields, defaultFields: CALENDAR_FIELDS },
    )

    return {
      account: email,
      calendars,
      total: calendars.length,
      hasMore: Boolean(response.data.nextPageToken),
      nextCursor: response.data.nextPageToken ?? null,
    }
  },
}
