import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { runCalendarCall } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

export const deleteEvent: ToolConfig = {
  description:
    "Delete an event by ID. Optional sendUpdates controls whether attendees receive a cancellation notice. Returns the structured operation result — the renderer composes any user-facing message.",
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string" },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Send cancellation notice to attendees. Default "none".',
      },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { eventId, calendarId, sendUpdates } = args as {
      eventId: string
      calendarId?: string
      sendUpdates?: SendUpdates
    }
    const send = normaliseSendUpdates(sendUpdates)
    const targetCalendar = calendarId ?? "primary"

    await runCalendarCall(() =>
      calendar.events.delete({
        calendarId: targetCalendar,
        eventId,
        sendUpdates: send,
      }),
    )

    return {
      success: true,
      account: email,
      calendarId: targetCalendar,
      eventId,
      sendUpdates: send,
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
