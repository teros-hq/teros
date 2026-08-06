import { describe, expect, it } from "bun:test"
import {
  extractAttachment,
  extractAttendee,
  extractCalendarShape,
  extractColorsShape,
  extractEventShape,
  extractFocusTimeProperties,
  extractFreeBusy,
  extractOutOfOfficeProperties,
  extractPerson,
  extractSettingShape,
  extractWorkingLocationProperties,
} from "../../src/tools/_event-helpers"

describe("extractEventShape", () => {
  it("flattens timed event with timezone", () => {
    const raw = {
      id: "evt_1",
      summary: "Standup",
      start: { dateTime: "2026-04-27T09:00:00+02:00", timeZone: "Europe/Madrid" },
      end: { dateTime: "2026-04-27T09:30:00+02:00", timeZone: "Europe/Madrid" },
      status: "confirmed",
    }
    const out = extractEventShape(raw)
    expect(out.id).toBe("evt_1")
    expect(out.summary).toBe("Standup")
    expect(out.start).toBe("2026-04-27T09:00:00+02:00")
    expect(out.end).toBe("2026-04-27T09:30:00+02:00")
    expect(out.timeZone).toBe("Europe/Madrid")
    expect(out.allDay).toBe(false)
    expect(out.status).toBe("confirmed")
  })

  it("detects all-day events from date (no dateTime)", () => {
    const raw = {
      id: "evt_2",
      summary: "Bank holiday",
      start: { date: "2026-05-01" },
      end: { date: "2026-05-02" },
    }
    const out = extractEventShape(raw)
    expect(out.allDay).toBe(true)
    expect(out.start).toBe("2026-05-01")
    expect(out.end).toBe("2026-05-02")
  })

  it("exposes attendees with responseStatus", () => {
    const raw = {
      id: "evt_3",
      attendees: [
        { email: "a@x.com", responseStatus: "accepted", organizer: true },
        { email: "b@x.com", responseStatus: "tentative", optional: true },
      ],
      start: { dateTime: "2026-04-27T09:00:00Z" },
      end: { dateTime: "2026-04-27T10:00:00Z" },
    }
    const out = extractEventShape(raw)
    expect(out.attendees).toHaveLength(2)
    expect(out.attendees?.[0].responseStatus).toBe("accepted")
    expect(out.attendees?.[0].organizer).toBe(true)
    expect(out.attendees?.[1].optional).toBe(true)
  })

  it("describes recurrence as legible phrase", () => {
    const raw = {
      id: "evt_4",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"],
      start: { dateTime: "2026-04-28T15:00:00Z" },
      end: { dateTime: "2026-04-28T16:00:00Z" },
    }
    const out = extractEventShape(raw)
    expect(out.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=TU,TH"])
    expect(out.recurrenceDescription).toBe("Weekly on Tue, Thu")
  })

  it("extracts conferenceData entry points", () => {
    const raw = {
      id: "evt_5",
      hangoutLink: "https://meet.google.com/abc-defg",
      conferenceData: {
        conferenceId: "abc-defg",
        conferenceSolution: { key: { type: "hangoutsMeet" } },
        entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg" }],
      },
      start: { dateTime: "2026-04-27T09:00:00Z" },
      end: { dateTime: "2026-04-27T10:00:00Z" },
    }
    const out = extractEventShape(raw)
    expect(out.hangoutLink).toBe("https://meet.google.com/abc-defg")
    expect(out.conferenceData?.type).toBe("hangoutsMeet")
    expect(out.conferenceData?.entryPoints?.[0].uri).toBe("https://meet.google.com/abc-defg")
  })

  it("strips undefined keys (no null pollution)", () => {
    const raw = {
      id: "evt_6",
      start: { dateTime: "2026-04-27T09:00:00Z" },
      end: { dateTime: "2026-04-27T10:00:00Z" },
    }
    const out = extractEventShape(raw)
    expect(out).not.toHaveProperty("description")
    expect(out).not.toHaveProperty("location")
    expect(out).not.toHaveProperty("attendees")
    expect(out).not.toHaveProperty("recurrence")
  })
})

describe("extractAttendee", () => {
  it("keeps responseStatus, organizer, optional, self, comment", () => {
    const out = extractAttendee({
      email: "me@x.com",
      displayName: "Me",
      responseStatus: "accepted",
      organizer: false,
      optional: true,
      self: true,
      comment: "See you there",
    })
    expect(out).toEqual({
      email: "me@x.com",
      displayName: "Me",
      responseStatus: "accepted",
      optional: true,
      self: true,
      comment: "See you there",
    })
  })
})

describe("extractPerson", () => {
  it("preserves email, displayName, self", () => {
    const out = extractPerson({ email: "org@x.com", displayName: "Org", self: false })
    expect(out).toEqual({ email: "org@x.com", displayName: "Org" })
  })
})

describe("extractCalendarShape", () => {
  it("keeps brand colors and access role", () => {
    const out = extractCalendarShape({
      id: "cal_1",
      summary: "Work",
      timeZone: "Europe/Madrid",
      primary: true,
      accessRole: "owner",
      backgroundColor: "#039BE5",
      foregroundColor: "#FFFFFF",
      colorId: "7",
    })
    expect(out).toEqual({
      id: "cal_1",
      summary: "Work",
      timeZone: "Europe/Madrid",
      primary: true,
      accessRole: "owner",
      backgroundColor: "#039BE5",
      foregroundColor: "#FFFFFF",
      colorId: "7",
    })
  })
})

describe("extractFreeBusy", () => {
  it("curates busy slots with durationMinutes", () => {
    const out = extractFreeBusy("primary", {
      busy: [
        { start: "2026-04-27T09:00:00Z", end: "2026-04-27T10:00:00Z" },
        { start: "2026-04-27T14:00:00Z", end: "2026-04-27T15:30:00Z" },
      ],
    })
    expect(out.calendarId).toBe("primary")
    expect(out.busy).toHaveLength(2)
    expect(out.busy[0]).toEqual({
      startISO: "2026-04-27T09:00:00Z",
      endISO: "2026-04-27T10:00:00Z",
      durationMinutes: 60,
    })
    expect(out.busy[1].durationMinutes).toBe(90)
  })

  it("exposes errors when calendar unreachable", () => {
    const out = extractFreeBusy("busy@x.com", {
      busy: [],
      errors: [{ domain: "global", reason: "notFound" }],
    })
    expect(out.errors).toEqual([{ domain: "global", reason: "notFound" }])
  })

  it("defaults to empty busy[] when raw missing", () => {
    const out = extractFreeBusy("primary", undefined)
    expect(out.calendarId).toBe("primary")
    expect(out.busy).toEqual([])
  })
})

// ============================================================================
// Sprint 4 — eventType, *Properties, attachments, settings, colors
// ============================================================================

describe("extractEventShape — eventType + specialized properties", () => {
  it("defaults eventType to 'default' when API does not return it", () => {
    const out = extractEventShape({
      id: "evt",
      start: { dateTime: "2026-04-28T09:00:00Z" },
      end: { dateTime: "2026-04-28T10:00:00Z" },
    })
    expect(out.eventType).toBe("default")
  })

  it("preserves focusTime + focusTimeProperties", () => {
    const out = extractEventShape({
      id: "ft",
      eventType: "focusTime",
      start: { dateTime: "2026-04-28T09:00:00Z" },
      end: { dateTime: "2026-04-28T11:00:00Z" },
      focusTimeProperties: {
        autoDeclineMode: "declineAllConflictingInvitations",
        chatStatus: "doNotDisturb",
        declineMessage: "Heads down.",
      },
    })
    expect(out.eventType).toBe("focusTime")
    expect(out.focusTimeProperties).toEqual({
      autoDeclineMode: "declineAllConflictingInvitations",
      chatStatus: "doNotDisturb",
      declineMessage: "Heads down.",
    })
  })

  it("preserves outOfOfficeProperties", () => {
    const out = extractEventShape({
      id: "ooo",
      eventType: "outOfOffice",
      start: { dateTime: "2026-05-01T00:00:00Z" },
      end: { dateTime: "2026-05-08T00:00:00Z" },
      outOfOfficeProperties: {
        autoDeclineMode: "declineAllConflictingInvitations",
        declineMessage: "On vacation.",
      },
    })
    expect(out.eventType).toBe("outOfOffice")
    expect(out.outOfOfficeProperties?.declineMessage).toBe("On vacation.")
  })

  it("preserves workingLocationProperties (homeOffice)", () => {
    const out = extractEventShape({
      id: "wl",
      eventType: "workingLocation",
      start: { date: "2026-05-02" },
      end: { date: "2026-05-03" },
      workingLocationProperties: { type: "homeOffice", homeOffice: {} },
    })
    expect(out.eventType).toBe("workingLocation")
    expect(out.workingLocationProperties?.type).toBe("homeOffice")
  })

  it("preserves workingLocationProperties (officeLocation with label + buildingId)", () => {
    const out = extractEventShape({
      id: "wl2",
      eventType: "workingLocation",
      start: { dateTime: "2026-05-02T09:00:00Z" },
      end: { dateTime: "2026-05-02T17:00:00Z" },
      workingLocationProperties: {
        type: "officeLocation",
        officeLocation: { buildingId: "BLDG-1", label: "NYC HQ" },
      },
    })
    expect(out.workingLocationProperties?.officeLocation).toEqual({
      buildingId: "BLDG-1",
      label: "NYC HQ",
    })
  })

  it("preserves attachments[]", () => {
    const out = extractEventShape({
      id: "att",
      start: { dateTime: "2026-04-28T09:00:00Z" },
      end: { dateTime: "2026-04-28T10:00:00Z" },
      attachments: [
        {
          fileUrl: "https://docs.google.com/document/d/abc/edit",
          title: "Meeting notes",
          mimeType: "application/vnd.google-apps.document",
          iconLink: "https://drive-thirdparty.googleusercontent.com/16/type/document",
          fileId: "abc",
        },
      ],
    })
    expect(out.attachments).toHaveLength(1)
    expect(out.attachments?.[0]).toEqual({
      fileUrl: "https://docs.google.com/document/d/abc/edit",
      title: "Meeting notes",
      mimeType: "application/vnd.google-apps.document",
      iconLink: "https://drive-thirdparty.googleusercontent.com/16/type/document",
      fileId: "abc",
    })
  })
})

describe("extractFocusTimeProperties / OutOfOfficeProperties / WorkingLocationProperties", () => {
  it("strips undefined fields in focus time", () => {
    expect(extractFocusTimeProperties({ autoDeclineMode: "declineNone" })).toEqual({
      autoDeclineMode: "declineNone",
    })
  })
  it("OOO defaults declineMessage to undefined when not provided", () => {
    const out = extractOutOfOfficeProperties({ autoDeclineMode: "declineNone" })
    expect(out).toEqual({ autoDeclineMode: "declineNone" })
  })
  it("working location preserves customLocation", () => {
    const out = extractWorkingLocationProperties({
      type: "customLocation",
      customLocation: { label: "Beach office" },
    })
    expect(out.customLocation).toEqual({ label: "Beach office" })
  })
})

describe("extractAttachment", () => {
  it("returns empty fileUrl when raw lacks it (defensive)", () => {
    expect(extractAttachment({}).fileUrl).toBe("")
  })
})

describe("extractSettingShape", () => {
  it("returns id+value pair", () => {
    expect(extractSettingShape({ id: "timezone", value: "Europe/Madrid" })).toEqual({
      id: "timezone",
      value: "Europe/Madrid",
    })
  })
  it("defaults missing values to empty strings", () => {
    expect(extractSettingShape({})).toEqual({ id: "", value: "" })
  })
})

describe("extractColorsShape", () => {
  it("preserves event + calendar palettes", () => {
    const out = extractColorsShape({
      kind: "calendar#colors",
      updated: "2026-04-28T00:00:00Z",
      event: {
        "1": { background: "#7986CB", foreground: "#FFFFFF" },
        "2": { background: "#33B679", foreground: "#FFFFFF" },
      },
      calendar: {
        "1": { background: "#AC725E", foreground: "#FFFFFF" },
      },
    })
    expect(out.event?.["1"]).toEqual({ background: "#7986CB", foreground: "#FFFFFF" })
    expect(out.calendar?.["1"].background).toBe("#AC725E")
    expect(out.kind).toBe("calendar#colors")
  })

  it("returns empty objects when raw lacks event/calendar maps", () => {
    const out = extractColorsShape({})
    expect(out.event).toEqual({})
    expect(out.calendar).toEqual({})
  })
})
