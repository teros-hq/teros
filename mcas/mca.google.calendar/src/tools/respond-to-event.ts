import type { ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { runCalendarCall, wrapCalendarCall } from "./utils"

const RESPONSES = ["accepted", "declined", "tentative"] as const
type RsvpResponse = (typeof RESPONSES)[number]

const SEND_UPDATES = ["all", "externalOnly", "none"] as const
type SendUpdates = (typeof SEND_UPDATES)[number]

interface RespondArgs {
  eventId: string
  response: RsvpResponse
  comment?: string
  calendarId?: string
  sendUpdates?: SendUpdates
}

export const respondToEvent: ToolConfig = {
  description:
    'RSVP to a calendar event as the connected user. Reads the event\'s attendee list, locates the user (self), and patches their responseStatus to "accepted" / "declined" / "tentative" (optionally with a comment). If the user is not currently in the attendee list, they are added so the patch creates the entry. Returns {success, account, eventId, response, eventSummary}.',
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string" },
      response: {
        type: "string",
        enum: ["accepted", "declined", "tentative"],
        description: "New responseStatus for the connected user.",
      },
      comment: {
        type: "string",
        description: "Optional reply comment shown next to the RSVP.",
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      sendUpdates: {
        type: "string",
        enum: ["all", "externalOnly", "none"],
        description: 'Notify the organizer + other attendees of the RSVP. Default "none".',
      },
    },
    required: ["eventId", "response"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const { eventId, response, comment, calendarId, sendUpdates } = args as unknown as RespondArgs

    if (!RESPONSES.includes(response)) {
      throw new Error(`Invalid response "${response}". Use accepted | declined | tentative.`)
    }
    const targetCalendar = calendarId ?? "primary"
    const send = normaliseSendUpdates(sendUpdates)

    const existing = await wrapCalendarCall(() =>
      calendar.events.get({ calendarId: targetCalendar, eventId }),
    )
    const eventSummary = existing.data.summary ?? null
    const attendees = (existing.data.attendees ?? []) as calendar_v3.Schema$EventAttendee[]

    const lowerEmail = email.toLowerCase()
    const myIndex = attendees.findIndex(
      (att) => att.self === true || att.email?.toLowerCase() === lowerEmail,
    )
    const previous: RsvpResponse | undefined =
      myIndex >= 0 &&
      (RESPONSES as readonly string[]).includes(attendees[myIndex].responseStatus ?? "")
        ? (attendees[myIndex].responseStatus as RsvpResponse)
        : undefined

    if (myIndex >= 0) {
      attendees[myIndex] = {
        ...attendees[myIndex],
        responseStatus: response,
        ...(comment !== undefined ? { comment } : {}),
      }
    } else {
      attendees.push({
        email,
        self: true,
        responseStatus: response,
        ...(comment ? { comment } : {}),
      })
    }

    const patch = await runCalendarCall(() =>
      calendar.events.patch({
        calendarId: targetCalendar,
        eventId,
        sendUpdates: send,
        requestBody: { attendees },
      }),
    )

    return {
      success: true,
      account: email,
      calendarId: targetCalendar,
      eventId: patch.data.id ?? eventId,
      eventSummary,
      response,
      previousResponse: previous ?? null,
      sendUpdates: send,
      addedAttendee: myIndex < 0,
    }
  },
}

function normaliseSendUpdates(value: unknown): SendUpdates {
  if (typeof value === "string" && (SEND_UPDATES as readonly string[]).includes(value)) {
    return value as SendUpdates
  }
  return "none"
}
