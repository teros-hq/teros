import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface ImportEventArgs {
  iCalUID: string
  summary: string
  start: string
  end: string
  calendarId?: string
  attendees?: string[]
  location?: string
  description?: string
  sendUpdates?: SendUpdates
  fields?: string[]
  includeRaw?: boolean
}

export const importEvent: ToolConfig = {
  description:
    "Import an external event (with iCalUID) into a calendar. Creates a private copy — distinct from create-event because it preserves the original UID for cross-system reconciliation. Use when the agent receives a `.ics` file or an event reference from another system. Only events with eventType='default' may be imported.",
  parameters: {
    type: "object",
    properties: {
      iCalUID: {
        type: "string",
        description: "External UID from the original event (e.g. from a .ics file).",
      },
      summary: { type: "string" },
      start: { type: "string", description: "ISO 8601 start with timezone offset." },
      end: { type: "string", description: "ISO 8601 end with timezone offset." },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      attendees: { type: "array", items: { type: "string" } },
      location: { type: "string" },
      description: { type: "string" },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Default "none".',
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["iCalUID", "summary", "start", "end"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as ImportEventArgs
    const calendarId = a.calendarId ?? "primary"
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    const requestBody: calendar_v3.Schema$Event = {
      iCalUID: a.iCalUID,
      summary: a.summary,
      start: { dateTime: a.start },
      end: { dateTime: a.end },
    }
    if (a.location) requestBody.location = a.location
    if (a.description) requestBody.description = a.description
    if (a.attendees && a.attendees.length > 0) {
      requestBody.attendees = a.attendees.map((emailAddr) => ({ email: emailAddr }))
    }

    const response = await runCalendarCall(() =>
      calendar.events.import({ calendarId, sendUpdates, requestBody }),
    )
    const raw = response.data
    const event = resolveFields(extractEventShape(raw) as unknown as Record<string, unknown>, raw, {
      includeRaw: a.includeRaw,
      fields: a.fields,
      defaultFields: EVENT_FIELDS,
    })

    return {
      success: true,
      account: email,
      calendarId,
      eventId: raw.id ?? null,
      iCalUID: a.iCalUID,
      event,
      sendUpdates,
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
