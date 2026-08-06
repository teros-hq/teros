import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall, validateAttachment } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface CreateEventArgs {
  summary: string
  start: string
  end: string
  timeZone?: string
  calendarId?: string
  description?: string
  location?: string
  attendees?: string[]
  recurrence?: string[]
  addConference?: boolean
  sendUpdates?: SendUpdates
  reminders?: { overrides?: Array<{ method: string; minutes: number }>; useDefault?: boolean }
  colorId?: string
  attachments?: Array<{
    fileUrl: string
    title?: string
    mimeType?: string
    iconLink?: string
    fileId?: string
  }>
  fields?: string[]
  includeRaw?: boolean
}

export const createEvent: ToolConfig = {
  description:
    "Create a calendar event. Supports recurrence (RRULE), Google Meet via addConference, attendee notifications via sendUpdates, custom reminders, and per-event color. Returns curated event with hangoutLink + htmlLink. Params: summary, start, end, plus optional calendarId, description, location, attendees, recurrence, addConference, sendUpdates, reminders, colorId.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Event title." },
      start: {
        type: "string",
        description:
          'ISO 8601 start. Use full timezone offset to avoid ambiguity (e.g. "2026-04-29T14:00:00+02:00").',
      },
      end: {
        type: "string",
        description: "ISO 8601 end with timezone offset.",
      },
      timeZone: {
        type: "string",
        description:
          'IANA timezone name (e.g. "Europe/Madrid"). Optional override. If omitted on recurring events, the handler resolves it from the user\'s Calendar settings automatically.',
      },
      calendarId: { type: "string", description: 'Calendar ID. Defaults to "primary".' },
      description: { type: "string", description: "Event body. May contain HTML." },
      location: { type: "string" },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "Attendee emails (optional).",
      },
      recurrence: {
        type: "array",
        items: { type: "string" },
        description: 'RRULE strings (e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"]).',
      },
      addConference: {
        type: "boolean",
        description: "Generate a Google Meet link automatically. Default false.",
      },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description:
          'Notify attendees: "all" notifies everyone, "externalOnly" skips users in the same domain, "none" silent. Default "none".',
      },
      reminders: {
        type: "object",
        description:
          'Reminder overrides. {overrides:[{method:"popup"|"email", minutes}], useDefault:false}. If useDefault=true, calendar defaults are used.',
      },
      colorId: {
        type: "string",
        description: "Google Calendar color id (1-11) for the event tile.",
      },
      attachments: {
        type: "array",
        description:
          "Drive files to attach. Each item: { fileUrl: required, title?, mimeType?, iconLink?, fileId? }. fileUrl must be the Drive `alternateLink` (or webViewLink). The MCA forwards `supportsAttachments=true` to Google.",
        items: {
          type: "object",
          properties: {
            fileUrl: { type: "string" },
            title: { type: "string" },
            mimeType: { type: "string" },
            iconLink: { type: "string" },
            fileId: { type: "string" },
          },
          required: ["fileUrl"],
        },
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Override default whitelist on the returned event.",
      },
      includeRaw: { type: "boolean", description: "Return raw Google response. Default false." },
    },
    required: ["summary", "start", "end"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const session = await getCalendarSession(context)
    const { calendar, email } = session
    const a = args as unknown as CreateEventArgs
    const calendarId = a.calendarId ?? "primary"
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    // Recurring events MUST carry an explicit IANA timeZone in start/end —
    // Google rejects them otherwise. The agent rarely knows the user's tz,
    // so when it omits the arg we resolve via settings.get (cached per
    // session). Explicit arg wins. Detected during smoke audit (Iria, 28-Apr-2026).
    const hasRecurrence = Boolean(a.recurrence && a.recurrence.length > 0)
    const resolvedTimeZone =
      a.timeZone ?? (hasRecurrence ? await session.getUserTimeZone() : undefined)

    const startObj: calendar_v3.Schema$EventDateTime = { dateTime: a.start }
    const endObj: calendar_v3.Schema$EventDateTime = { dateTime: a.end }
    if (resolvedTimeZone) {
      startObj.timeZone = resolvedTimeZone
      endObj.timeZone = resolvedTimeZone
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary: a.summary,
      start: startObj,
      end: endObj,
    }
    if (a.description) requestBody.description = a.description
    if (a.location) requestBody.location = a.location
    if (a.attendees && a.attendees.length > 0) {
      requestBody.attendees = a.attendees.map((emailAddr) => ({ email: emailAddr }))
    }
    if (a.recurrence && a.recurrence.length > 0) {
      requestBody.recurrence = a.recurrence
    }
    if (a.colorId) requestBody.colorId = a.colorId
    if (a.reminders) {
      requestBody.reminders = {
        useDefault: a.reminders.useDefault ?? false,
        overrides: a.reminders.overrides,
      }
    }
    if (a.addConference) {
      requestBody.conferenceData = {
        createRequest: {
          requestId: `mca-cal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      }
    }
    if (a.attachments && a.attachments.length > 0) {
      requestBody.attachments = a.attachments.map((att, idx) => {
        validateAttachment(att, idx)
        return {
          fileUrl: att.fileUrl,
          ...(att.title !== undefined ? { title: att.title } : {}),
          ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
          ...(att.iconLink !== undefined ? { iconLink: att.iconLink } : {}),
          ...(att.fileId !== undefined ? { fileId: att.fileId } : {}),
        }
      })
    }

    const response = await runCalendarCall(() =>
      calendar.events.insert({
        calendarId,
        sendUpdates,
        ...(a.addConference ? { conferenceDataVersion: 1 } : {}),
        ...(a.attachments && a.attachments.length > 0 ? { supportsAttachments: true } : {}),
        requestBody,
      }),
    )
    const raw = response.data
    const shape = extractEventShape(raw)
    const event = resolveFields(shape as unknown as Record<string, unknown>, raw, {
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
      meetGenerated: Boolean(raw.hangoutLink || raw.conferenceData?.entryPoints?.length),
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
