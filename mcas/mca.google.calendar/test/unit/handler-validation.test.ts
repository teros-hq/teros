/**
 * Validation guards inside handlers — fast tests that exercise the `throw new
 * Error(...)` paths *before* any Google API call.
 *
 * Strategy: build a context whose secrets pass `getCalendarSession`'s sanity
 * check and whose `EXPIRY_DATE` is far in the future so `refreshAccessToken`
 * is never invoked. The OAuth2Client object is constructed locally in
 * `googleapis` and does not hit the network until we call `events.*`. Each
 * handler validates its args BEFORE any `events.*` call, so the network is
 * never touched here.
 *
 * This lets us assert error messages for:
 *  - list-events: syncToken exclusivity, missing dates, invalid eventTypes.
 *  - create-focus-time / create-out-of-office: all-day rejection.
 *  - set-working-location: invalid type.
 *  - update-event: replaceAttendees mutually exclusive with add/remove.
 *  - respond-to-event: invalid RSVP response.
 *
 * Integration tests with mocked googleapis live in a separate sub-issue.
 */

import { describe, expect, it } from "bun:test"
import { createFocusTime } from "../../src/tools/create-focus-time"
import { createOutOfOffice } from "../../src/tools/create-out-of-office"
import { listEvents } from "../../src/tools/list-events"
import { respondToEvent } from "../../src/tools/respond-to-event"
import { setWorkingLocation } from "../../src/tools/set-working-location"
import { updateEvent } from "../../src/tools/update-event"

// ============================================================================
// Mock context — secrets present, expiry far in the future.
// ============================================================================

function buildContext() {
  return {
    execution: {
      userId: "u",
      appId: "a",
      mcaId: "mca.google.calendar",
    },
    backend: null,
    getSystemSecrets: async () => ({
      CLIENT_ID: "fake-id",
      CLIENT_SECRET: "fake-secret",
      REDIRECT_URIS: "https://example/cb",
    }),
    getUserSecrets: async () => ({
      ACCESS_TOKEN: "fake-token",
      REFRESH_TOKEN: "fake-refresh",
      EMAIL: "me@example.com",
      // ~1 year in the future — well past the 60s refresh threshold.
      EXPIRY_DATE: String(Date.now() + 365 * 24 * 60 * 60 * 1000),
    }),
    updateUserSecrets: async () => {},
    getScope: () => "u",
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
    // biome-ignore lint/suspicious/noExplicitAny: tests cast loosely
  } as any
}

// ============================================================================
// list-events
// ============================================================================

describe("listEvents — validation", () => {
  it("rejects syncToken combined with startDate", async () => {
    await expect(
      listEvents.handler(
        { syncToken: "abc", startDate: "2026-04-28T00:00:00Z", endDate: "2026-04-29T00:00:00Z" },
        buildContext(),
      ),
    ).rejects.toThrow(/syncToken is exclusive/)
  })

  it("rejects syncToken combined with eventTypes", async () => {
    await expect(
      listEvents.handler({ syncToken: "abc", eventTypes: ["focusTime"] }, buildContext()),
    ).rejects.toThrow(/syncToken is exclusive/)
  })

  it("requires startDate and endDate when no syncToken", async () => {
    await expect(listEvents.handler({}, buildContext())).rejects.toThrow(
      /startDate and endDate are required/,
    )
  })

  it("requires endDate when only startDate is passed", async () => {
    await expect(
      listEvents.handler({ startDate: "2026-04-28T00:00:00Z" }, buildContext()),
    ).rejects.toThrow(/startDate and endDate are required/)
  })

  it("rejects invalid eventTypes", async () => {
    await expect(
      listEvents.handler(
        {
          startDate: "2026-04-28T00:00:00Z",
          endDate: "2026-04-29T00:00:00Z",
          eventTypes: ["invalidType"],
        },
        buildContext(),
      ),
    ).rejects.toThrow(/Invalid eventTypes/)
  })
})

// ============================================================================
// create-focus-time
// ============================================================================

describe("createFocusTime — validation", () => {
  it("rejects all-day start", async () => {
    await expect(
      createFocusTime.handler(
        { start: "2026-04-28", end: "2026-04-28T11:00:00+02:00" },
        buildContext(),
      ),
    ).rejects.toThrow(/cannot be all-day/)
  })

  it("rejects all-day end", async () => {
    await expect(
      createFocusTime.handler(
        { start: "2026-04-28T09:00:00+02:00", end: "2026-04-28" },
        buildContext(),
      ),
    ).rejects.toThrow(/cannot be all-day/)
  })
})

// ============================================================================
// create-out-of-office
// ============================================================================

describe("createOutOfOffice — validation", () => {
  it("rejects all-day start", async () => {
    await expect(
      createOutOfOffice.handler(
        { start: "2026-05-01", end: "2026-05-08T00:00:00Z" },
        buildContext(),
      ),
    ).rejects.toThrow(/cannot be all-day/)
  })
})

// ============================================================================
// set-working-location
// ============================================================================

describe("setWorkingLocation — validation", () => {
  it("rejects invalid type", async () => {
    await expect(
      setWorkingLocation.handler(
        {
          start: "2026-05-02T09:00:00Z",
          end: "2026-05-02T17:00:00Z",
          type: "spaceStation",
        },
        buildContext(),
      ),
    ).rejects.toThrow(/Invalid type/)
  })
})

// ============================================================================
// update-event
// ============================================================================

describe("updateEvent — attendee mutex", () => {
  it("rejects replaceAttendees combined with addAttendees", async () => {
    await expect(
      updateEvent.handler(
        {
          eventId: "evt",
          replaceAttendees: ["a@x.com"],
          addAttendees: ["b@x.com"],
        },
        buildContext(),
      ),
    ).rejects.toThrow(/replaceAttendees is exclusive/)
  })

  it("rejects replaceAttendees combined with removeAttendees", async () => {
    await expect(
      updateEvent.handler(
        {
          eventId: "evt",
          replaceAttendees: ["a@x.com"],
          removeAttendees: ["c@x.com"],
        },
        buildContext(),
      ),
    ).rejects.toThrow(/replaceAttendees is exclusive/)
  })
})

// ============================================================================
// respond-to-event
// ============================================================================

describe("respondToEvent — validation", () => {
  it("rejects invalid response", async () => {
    await expect(
      respondToEvent.handler({ eventId: "evt", response: "maybe" }, buildContext()),
    ).rejects.toThrow(/Invalid response/)
  })
})

// ============================================================================
// create-event / update-event — recurrence requires explicit timeZone
// (Iria smoke audit, 28-Apr-2026, BUG P1)
// ============================================================================

// Note on the recurrence + timeZone behaviour:
//
// Google Calendar requires an explicit IANA timeZone in start/end for any
// event with recurrence. The handler resolves this transparently — when the
// agent omits `timeZone` on a recurring event, it falls back to the user's
// `settings.get({setting:'timezone'})` (cached on the session). The agent
// does not need to know about this coupling.
//
// The fallback path hits the live Google API, so we don't unit-test it here
// (this file is for pure validation guards). It's covered by the smoke audit
// (Iria, 28-Apr-2026, BUG P1 originally surfaced this).
