import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface MoveEventArgs {
  eventId: string
  sourceCalendarId: string
  destinationCalendarId: string
  sendUpdates?: SendUpdates
  fields?: string[]
  includeRaw?: boolean
}

export const moveEvent: ToolConfig = {
  description:
    'Move an event from one calendar to another. RESTRICTION: only `eventType: "default"` is movable — birthday/focusTime/outOfOffice/workingLocation/fromGmail events return an error. Returns the moved event in the destination calendar shape.',
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string" },
      sourceCalendarId: {
        type: "string",
        description: "Calendar where the event currently lives.",
      },
      destinationCalendarId: { type: "string", description: "Target calendar ID." },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify attendees of the move. Default "none".',
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["eventId", "sourceCalendarId", "destinationCalendarId"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as MoveEventArgs
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    try {
      const response = await runCalendarCall(() =>
        calendar.events.move({
          calendarId: a.sourceCalendarId,
          eventId: a.eventId,
          destination: a.destinationCalendarId,
          sendUpdates,
        }),
      )
      const raw = response.data
      const event = resolveFields(
        extractEventShape(raw) as unknown as Record<string, unknown>,
        raw,
        {
          includeRaw: a.includeRaw,
          fields: a.fields,
          defaultFields: EVENT_FIELDS,
        },
      )

      return {
        success: true,
        account: email,
        eventId: raw.id ?? a.eventId,
        sourceCalendarId: a.sourceCalendarId,
        destinationCalendarId: a.destinationCalendarId,
        event,
        sendUpdates,
      }
    } catch (error: unknown) {
      const e = error as {
        code?: number | string
        errors?: Array<{ reason?: string }>
        message?: string
      }
      const reason = e.errors?.[0]?.reason
      const code = typeof e.code === "string" ? Number.parseInt(e.code, 10) : e.code
      if (
        code === 400 &&
        (reason === "cannotChangeOrganizer" || reason === "cannotChangeOrganizerOfInstance")
      ) {
        throw new Error(
          "Cannot move this event. Only events with eventType='default' are movable. Birthday/focusTime/outOfOffice/workingLocation/fromGmail events stay on their original calendar.",
        )
      }
      if (code === 403 && reason === "accessNotConfigured") {
        throw new Error(
          `${e.message ?? "Calendar API not enabled"}. Enable Google Calendar API at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com — reconnecting OAuth will NOT fix this.`,
        )
      }
      throw error
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
