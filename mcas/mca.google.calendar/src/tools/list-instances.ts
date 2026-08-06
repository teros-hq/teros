import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { type CuratedEvent, extractEventShape } from "./_event-helpers"
import { INSTANCE_FIELDS } from "./_fields"
import { resolveFieldsList, sanitizeLimit, wrapCalendarCall } from "./utils"

interface ListInstancesArgs {
  eventId: string
  calendarId?: string
  timeMin?: string
  timeMax?: string
  limit?: number
  cursor?: string
  fields?: string[]
  includeRaw?: boolean
}

export const listInstances: ToolConfig = {
  description:
    "List instances of a recurring event with their override metadata. Returns rows with `originalStartTime` so the renderer can flag instances that were moved/modified vs. the recurring rule. Cursor pagination via `pageToken`.",
  parameters: {
    type: "object",
    properties: {
      eventId: {
        type: "string",
        description: "ID of the recurring (master) event whose instances to list.",
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      timeMin: { type: "string", description: "Optional ISO 8601 lower bound (inclusive)." },
      timeMax: { type: "string", description: "Optional ISO 8601 upper bound (exclusive)." },
      limit: { type: "number", description: "Max instances per page. Default 25, max 2500." },
      cursor: { type: "string", description: "Pagination cursor (Google nextPageToken)." },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { eventId, calendarId, timeMin, timeMax, limit, cursor, fields, includeRaw } =
      args as unknown as ListInstancesArgs
    const maxResults = sanitizeLimit(limit, { max: 2500, default: 25 })

    const response = await wrapCalendarCall(() =>
      calendar.events.instances({
        calendarId: calendarId ?? "primary",
        eventId,
        maxResults,
        ...(cursor ? { pageToken: cursor } : {}),
        ...(timeMin ? { timeMin } : {}),
        ...(timeMax ? { timeMax } : {}),
      }),
    )

    const rawItems = response.data.items ?? []
    const shaped: CuratedEvent[] = rawItems.map(extractEventShape)
    const instances = resolveFieldsList(
      shaped as unknown as Array<Record<string, unknown>>,
      rawItems,
      { includeRaw, fields, defaultFields: INSTANCE_FIELDS },
    )

    return {
      account: email,
      calendarId: calendarId ?? "primary",
      eventId,
      instances,
      total: instances.length,
      hasMore: Boolean(response.data.nextPageToken),
      nextCursor: response.data.nextPageToken ?? null,
    }
  },
}
