import type { HttpToolConfig as ToolConfig } from "@teros/mca-sdk"
import type { calendar_v3 } from "googleapis"
import { getCalendarSession } from "../lib"
import { extractEventShape } from "./_event-helpers"
import { EVENT_FIELDS } from "./_fields"
import { resolveFields, runCalendarCall } from "./utils"

const TYPES = ["homeOffice", "officeLocation", "customLocation"] as const
type WorkingLocationType = (typeof TYPES)[number]

interface OfficeLocation {
  buildingId?: string
  deskId?: string
  floorId?: string
  floorSectionId?: string
  label?: string
}

interface SetWorkingLocationArgs {
  start: string
  end: string
  type: WorkingLocationType
  officeLocation?: OfficeLocation
  customLocation?: { label?: string }
  calendarId?: string
  fields?: string[]
  includeRaw?: boolean
}

export const setWorkingLocation: ToolConfig = {
  description:
    'Mark the user working location for a date range. Created with eventType: "workingLocation" + visibility: "public" + transparency: "transparent" so it does not block free/busy. May be all-day (single day only) or timed.',
  parameters: {
    type: "object",
    properties: {
      start: {
        type: "string",
        description: 'ISO 8601 start. Use "YYYY-MM-DD" for an all-day single-day entry.',
      },
      end: {
        type: "string",
        description:
          "ISO 8601 end. For all-day, the day AFTER (Google convention — exclusive). For timed, full ISO with offset.",
      },
      type: {
        type: "string",
        enum: ["homeOffice", "officeLocation", "customLocation"],
        description: "Required. Drives which sub-properties are honored.",
      },
      officeLocation: {
        type: "object",
        description:
          "When type=officeLocation: { buildingId?, deskId?, floorId?, floorSectionId?, label? }. label is the human display name.",
      },
      customLocation: {
        type: "object",
        description:
          'When type=customLocation: { label? } — free-text location like "Beach office".',
      },
      calendarId: { type: "string", description: 'Defaults to "primary".' },
      fields: { type: "array", items: { type: "string" } },
      includeRaw: { type: "boolean" },
    },
    required: ["start", "end", "type"],
  },
  annotations: { readOnlyHint: false, version: "2.0.0", stability: "stable" },
  handler: async (args, context) => {
    const { calendar, email } = await getCalendarSession(context)
    const a = args as unknown as SetWorkingLocationArgs
    const calendarId = a.calendarId ?? "primary"

    if (!(TYPES as readonly string[]).includes(a.type)) {
      throw new Error(
        `Invalid type "${a.type}". Use one of: homeOffice | officeLocation | customLocation.`,
      )
    }

    const workingLocationProperties: calendar_v3.Schema$EventWorkingLocationProperties = {
      type: a.type,
    }
    if (a.type === "homeOffice") {
      workingLocationProperties.homeOffice = {}
    } else if (a.type === "officeLocation") {
      workingLocationProperties.officeLocation = a.officeLocation ?? { label: "Office" }
    } else if (a.type === "customLocation") {
      workingLocationProperties.customLocation = a.customLocation ?? { label: "Custom" }
    }

    const start = isAllDay(a.start) ? { date: a.start } : { dateTime: a.start }
    const end = isAllDay(a.end) ? { date: a.end } : { dateTime: a.end }

    const requestBody: calendar_v3.Schema$Event = {
      summary: humanLabel(a),
      eventType: "workingLocation",
      visibility: "public",
      transparency: "transparent",
      start,
      end,
      workingLocationProperties,
    }

    const response = await runCalendarCall(() =>
      calendar.events.insert({ calendarId, requestBody }),
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
    }
  },
}

function isAllDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function humanLabel(a: SetWorkingLocationArgs): string {
  if (a.type === "homeOffice") return "Working from home"
  if (a.type === "officeLocation") return `Working from ${a.officeLocation?.label ?? "the office"}`
  return `Working from ${a.customLocation?.label ?? "custom location"}`
}
