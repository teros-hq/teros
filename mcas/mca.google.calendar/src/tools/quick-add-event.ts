import type { ToolConfig } from "@teros/mca-sdk"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface QuickAddArgs {
  text: string
  calendarId?: string
  sendUpdates?: SendUpdates
  fields?: string[]
  includeRaw?: boolean
}

export const quickAddEvent: ToolConfig = {
  description:
    'Create an event from natural language ("Café con Antonio mañana 10am"). Google parses the text into title + date/time. Returns the curated event including the parsed start/end. Useful for low-effort scheduling. Note: only the title and time are inferred — for attendees, recurrence, location or Meet, use create-event instead.',
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: 'Free-form description (e.g. "lunch with Ana tomorrow 1pm").',
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify potential attendees parsed from the text. Default "none".',
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the returned event.",
      },
      includeRaw: { type: "boolean", description: "Return raw Google response. Default false." },
    },
    required: ["text"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { text, calendarId, sendUpdates, fields, includeRaw } = args as unknown as QuickAddArgs
    const targetCalendar = calendarId ?? "primary"
    const send = normaliseSendUpdates(sendUpdates)

    const response = await runCalendarCall(() =>
      calendar.events.quickAdd({
        calendarId: targetCalendar,
        text,
        sendUpdates: send,
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
      success: true,
      account: email,
      calendarId: targetCalendar,
      eventId: raw.id ?? null,
      sourceText: text,
      event,
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
