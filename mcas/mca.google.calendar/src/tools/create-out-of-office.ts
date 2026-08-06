import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall } from "./utils"

const AUTO_DECLINE_MODES = [
  "declineNone",
  "declineAllConflictingInvitations",
  "declineOnlyNewConflictingInvitations",
] as const
type AutoDeclineMode = (typeof AUTO_DECLINE_MODES)[number]

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface CreateOutOfOfficeArgs {
  start: string
  end: string
  summary?: string
  autoDeclineMode?: AutoDeclineMode
  declineMessage?: string
  calendarId?: string
  sendUpdates?: SendUpdates
  fields?: string[]
  includeRaw?: boolean
}

export const createOutOfOffice: ToolConfig = {
  description:
    'Mark the user as Out of Office. Created with eventType: "outOfOffice" + transparency: "opaque". By default declines all conflicting invitations with the provided message. NOT all-day; requires full ISO timestamps.',
  parameters: {
    type: "object",
    properties: {
      start: { type: "string", description: "ISO 8601 start with timezone offset." },
      end: { type: "string", description: "ISO 8601 end with timezone offset." },
      summary: { type: "string", description: 'Title. Defaults to "Out of office".' },
      autoDeclineMode: {
        type: "string",
        enum: [
          "declineNone",
          "declineAllConflictingInvitations",
          "declineOnlyNewConflictingInvitations",
        ],
        description: 'Default "declineAllConflictingInvitations".',
      },
      declineMessage: {
        type: "string",
        description: "Auto-reply sent when an invitation is declined while OOO.",
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify attendees of attached invitations. Default "none".',
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["start", "end"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as CreateOutOfOfficeArgs
    const calendarId = a.calendarId ?? "primary"
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    if (isAllDay(a.start) || isAllDay(a.end)) {
      throw new Error(
        "Out-of-office events cannot be all-day. Pass full ISO timestamps with timezone offset.",
      )
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary: a.summary ?? "Out of office",
      eventType: "outOfOffice",
      transparency: "opaque",
      start: { dateTime: a.start },
      end: { dateTime: a.end },
      outOfOfficeProperties: {
        autoDeclineMode: a.autoDeclineMode ?? "declineAllConflictingInvitations",
        ...(a.declineMessage !== undefined ? { declineMessage: a.declineMessage } : {}),
      },
    }

    const response = await runCalendarCall(() =>
      calendar.events.insert({ calendarId, sendUpdates, requestBody }),
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
      event,
      sendUpdates,
    }
  },
}

function isAllDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
