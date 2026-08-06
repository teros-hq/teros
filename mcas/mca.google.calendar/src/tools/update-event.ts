import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall, validateAttachment, wrapCalendarCall } from "./utils"

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface UpdateEventArgs {
  eventId: string
  calendarId?: string
  summary?: string
  start?: string
  end?: string
  timeZone?: string
  description?: string
  location?: string
  recurrence?: string[]
  addAttendees?: string[]
  removeAttendees?: string[]
  replaceAttendees?: string[]
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

export const updateEvent: ToolConfig = {
  description:
    "Patch an existing event. Attendee changes are explicit: addAttendees / removeAttendees merge with existing list, replaceAttendees overwrites everything (destructive). Supports updating recurrence, reminders, color, sendUpdates. Params: eventId required; all other fields optional. The handler issues at most ONE patch (events.get only runs when attendee merge is requested).",
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string" },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      summary: { type: "string" },
      start: { type: "string", description: "ISO 8601 with timezone offset." },
      end: { type: "string", description: "ISO 8601 with timezone offset." },
      timeZone: {
        type: "string",
        description:
          'IANA timezone name (e.g. "Europe/Madrid"). Optional override. If omitted when changing start/end of a recurring event, the handler resolves from the user\'s Calendar settings automatically.',
      },
      description: { type: "string" },
      location: { type: "string" },
      recurrence: {
        type: "array",
        items: { type: "string" },
        description: "RRULE strings. Pass an empty array to clear recurrence.",
      },
      addAttendees: {
        type: "array",
        items: { type: "string" },
        description: "Emails to add (existing attendees preserved).",
      },
      removeAttendees: {
        type: "array",
        items: { type: "string" },
        description: "Emails to remove (existing attendees preserved otherwise).",
      },
      replaceAttendees: {
        type: "array",
        items: { type: "string" },
        description:
          "Destructive: replaces the entire attendee list. Use with care — silently drops everyone not in this list.",
      },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify attendees of the change. Default "none".',
      },
      reminders: {
        type: "object",
        description: "Reminder overrides {overrides, useDefault}.",
      },
      colorId: { type: "string", description: "Google Calendar color id (1-11)." },
      attachments: {
        type: "array",
        description:
          "REPLACE the attachment list with this Drive file set. Pass an empty array to clear. The MCA forwards `supportsAttachments=true` to Google.",
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
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["eventId"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const session = await getCalendarSession(context)
    const { calendar, email } = session
    const a = args as unknown as UpdateEventArgs
    const calendarId = a.calendarId ?? "primary"
    const sendUpdates = normaliseSendUpdates(a.sendUpdates)

    if (a.replaceAttendees && (a.addAttendees || a.removeAttendees)) {
      throw new Error(
        "replaceAttendees is exclusive — do not combine with addAttendees or removeAttendees.",
      )
    }

    const updates: calendar_v3.Schema$Event = {}
    if (a.summary !== undefined) updates.summary = a.summary
    if (a.description !== undefined) updates.description = a.description
    if (a.location !== undefined) updates.location = a.location
    // Recurring events require explicit IANA timeZone in start/end. When the
    // patch touches start/end on a recurring event, resolve via settings.get
    // if the agent didn't provide one. Mirrors create-event behaviour.
    const touchesStartEnd = Boolean(a.start || a.end)
    const setsRecurrence = Boolean(a.recurrence && a.recurrence.length > 0)
    const resolvedTimeZone =
      a.timeZone ?? (setsRecurrence && touchesStartEnd ? await session.getUserTimeZone() : undefined)
    if (a.start) {
      updates.start = resolvedTimeZone
        ? { dateTime: a.start, timeZone: resolvedTimeZone }
        : { dateTime: a.start }
    }
    if (a.end) {
      updates.end = resolvedTimeZone
        ? { dateTime: a.end, timeZone: resolvedTimeZone }
        : { dateTime: a.end }
    }
    if (a.recurrence) updates.recurrence = a.recurrence
    if (a.colorId) updates.colorId = a.colorId
    if (a.reminders) {
      updates.reminders = {
        useDefault: a.reminders.useDefault ?? false,
        overrides: a.reminders.overrides,
      }
    }

    const needsAttendeeMerge = Boolean(a.addAttendees?.length || a.removeAttendees?.length)
    if (needsAttendeeMerge) {
      const existing = await wrapCalendarCall(() =>
        calendar.events.get({ calendarId, eventId: a.eventId }),
      )
      const current = (existing.data.attendees ?? []).filter(
        (att): att is { email: string } & typeof att => Boolean(att.email),
      )
      const toRemove = new Set((a.removeAttendees ?? []).map((e) => e.toLowerCase()))
      const merged = current.filter((att) => !toRemove.has(att.email.toLowerCase()))
      const existingEmails = new Set(merged.map((att) => att.email.toLowerCase()))
      for (const emailAddr of a.addAttendees ?? []) {
        if (!existingEmails.has(emailAddr.toLowerCase())) {
          merged.push({ email: emailAddr })
        }
      }
      updates.attendees = merged
    } else if (a.replaceAttendees) {
      updates.attendees = a.replaceAttendees.map((emailAddr) => ({ email: emailAddr }))
    }

    if (a.attachments) {
      updates.attachments = a.attachments.map((att, idx) => {
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
      calendar.events.patch({
        calendarId,
        eventId: a.eventId,
        sendUpdates,
        ...(a.attachments ? { supportsAttachments: true } : {}),
        requestBody: updates,
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
      eventId: raw.id ?? a.eventId,
      event,
      sendUpdates,
      attendeeChange: needsAttendeeMerge
        ? {
            mode: "merge",
            added: a.addAttendees?.length ?? 0,
            removed: a.removeAttendees?.length ?? 0,
          }
        : a.replaceAttendees
          ? { mode: "replace", total: a.replaceAttendees.length }
          : undefined,
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
