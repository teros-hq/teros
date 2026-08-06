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

const CHAT_STATUSES = ["available", "doNotDisturb"] as const
type ChatStatus = (typeof CHAT_STATUSES)[number]

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface CreateFocusTimeArgs {
  start: string
  end: string
  summary?: string
  autoDeclineMode?: AutoDeclineMode
  declineMessage?: string
  chatStatus?: ChatStatus
  calendarId?: string
  sendUpdates?: SendUpdates
  fields?: string[]
  includeRaw?: boolean
}

export const createFocusTime: ToolConfig = {
  description:
    'Block focus time on the user calendar. Created with eventType: "focusTime" + transparency: "opaque" so the slot is not all-day. Optionally auto-declines conflicting invitations and sets Chat status to "doNotDisturb". Returns the curated event.',
  parameters: {
    type: "object",
    properties: {
      start: {
        type: "string",
        description: 'ISO 8601 start with timezone offset (e.g. "2026-04-29T09:00:00+02:00").',
      },
      end: { type: "string", description: "ISO 8601 end with timezone offset." },
      summary: { type: "string", description: 'Title. Defaults to "Focus time".' },
      autoDeclineMode: {
        type: "string",
        enum: [
          "declineNone",
          "declineAllConflictingInvitations",
          "declineOnlyNewConflictingInvitations",
        ],
        description:
          'How to handle conflicting invitations during the focus time. Default "declineNone".',
      },
      declineMessage: {
        type: "string",
        description: "Message sent automatically when an invitation is declined.",
      },
      chatStatus: {
        type: "string",
        enum: ["available", "doNotDisturb"],
        description: 'Chat presence during focus time. Default "doNotDisturb".',
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify attendees if any are added. Default "none".',
      },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["start", "end"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as CreateFocusTimeArgs
    const calendarId = a.calendarId ?? "primary"
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    if (isAllDay(a.start) || isAllDay(a.end)) {
      throw new Error(
        "Focus time events cannot be all-day. Pass full ISO timestamps with timezone offset.",
      )
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary: a.summary ?? "Focus time",
      eventType: "focusTime",
      transparency: "opaque",
      start: { dateTime: a.start },
      end: { dateTime: a.end },
      focusTimeProperties: {
        autoDeclineMode: a.autoDeclineMode ?? "declineNone",
        chatStatus: a.chatStatus ?? "doNotDisturb",
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
  // YYYY-MM-DD without 'T' indicates all-day to Google.
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
