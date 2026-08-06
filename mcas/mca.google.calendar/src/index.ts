#!/usr/bin/env npx tsx

/**
 * Google Calendar MCA v2.0.0
 *
 * HTTP transport. Secrets fetched on-demand via `context.getSystemSecrets`/
 * `context.getUserSecrets`. Each tool lives in its own file under `tools/`
 * (see `mcas/mca.notion/` for the same pattern).
 *
 * Surface (19 tools, full Calendar API v3 reasonable coverage):
 *  Health
 *  - `-health-check` — credential + connectivity probe (HealthCheckBuilder).
 *  Discovery
 *  - `calendar-list-calendars` — discover the user's calendars.
 *  - `calendar-get-settings` — user preferences (timezone, locale, weekStart, ...).
 *  - `calendar-get-colors` — official Google palette (event + calendar colorIds).
 *  Events read
 *  - `calendar-list-events` — date range list, cursor + syncToken + eventTypes filter.
 *  - `calendar-get-event` — full detail by ID with parsed recurrence.
 *  - `calendar-search-events` — text search with optional eventTypes filter.
 *  - `calendar-list-instances` — instances of a recurring event with overrides.
 *  Events write (default)
 *  - `calendar-create-event` — full create (recurrence, Meet, reminders, attachments).
 *  - `calendar-update-event` — patch with explicit add/remove/replace attendees + attachments.
 *  - `calendar-delete-event` — delete with sendUpdates control.
 *  - `calendar-quick-add-event` — natural-language event creation (Google parser).
 *  - `calendar-import-event` — import an external event with iCalUID.
 *  - `calendar-move-event` — move a default event between calendars.
 *  Events write (specialized eventTypes)
 *  - `calendar-create-focus-time` — focusTime with autoDecline + chatStatus.
 *  - `calendar-create-out-of-office` — OOO with autoDecline + reply message.
 *  - `calendar-set-working-location` — homeOffice / officeLocation / customLocation.
 *  Attendee
 *  - `calendar-respond-to-event` — RSVP accept/decline/tentative as the connected user.
 *  Availability
 *  - `calendar-get-free-busy` — curated [{calendarId, busy:[...], errors?}].
 */

import { McaServer } from "@teros/mca-sdk"
import {
  createEvent,
  createFocusTime,
  createOutOfOffice,
  deleteEvent,
  getColors,
  getEvent,
  getFreeBusy,
  getSettings,
  healthCheck,
  importEvent,
  listCalendars,
  listEvents,
  listInstances,
  moveEvent,
  quickAddEvent,
  respondToEvent,
  searchEvents,
  setWorkingLocation,
  updateEvent,
} from "./tools"

const server = new McaServer({
  id: "mca.google.calendar",
  name: "Google Calendar",
  version: "2.0.0",
})

server.tool("-health-check", healthCheck)
server.tool("calendar-list-calendars", listCalendars)
server.tool("calendar-get-settings", getSettings)
server.tool("calendar-get-colors", getColors)
server.tool("calendar-list-events", listEvents)
server.tool("calendar-get-event", getEvent)
server.tool("calendar-search-events", searchEvents)
server.tool("calendar-list-instances", listInstances)
server.tool("calendar-create-event", createEvent)
server.tool("calendar-update-event", updateEvent)
server.tool("calendar-delete-event", deleteEvent)
server.tool("calendar-quick-add-event", quickAddEvent)
server.tool("calendar-import-event", importEvent)
server.tool("calendar-move-event", moveEvent)
server.tool("calendar-create-focus-time", createFocusTime)
server.tool("calendar-create-out-of-office", createOutOfOffice)
server.tool("calendar-set-working-location", setWorkingLocation)
server.tool("calendar-respond-to-event", respondToEvent)
server.tool("calendar-get-free-busy", getFreeBusy)

server.start()
