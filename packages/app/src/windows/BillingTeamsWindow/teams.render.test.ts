/**
 * TER-596 T1 — pure helpers for the billing teams window. The *WindowContent is
 * stubbed by the harness, so the testable logic (member search + the update
 * payload builder) lives in teams.ts and is asserted directly. Each test pins
 * the exact output so a mutation (include an unchanged field, drop the clear,
 * wrong color threshold) turns it red.
 */

import { describe, expect, it } from "vitest"
import type { TeamMember } from "../../services/AdminApi"
import {
  buildTeamSettingsPayload,
  filterMembers,
  memberHoursLabel,
  type TeamSettingsForm,
  type TeamSettingsOriginal,
  teamToForm,
  teamToOriginal,
  usageColor,
} from "./teams"

function member(over: Partial<TeamMember> = {}): TeamMember {
  return {
    userId: "u1",
    userName: "Alice Smith",
    userEmail: "alice@acme.io",
    role: "user",
    isOwner: false,
    planId: "plan_pro",
    planName: "Pro",
    agentHoursUsed: 10,
    agentHoursLimit: 80,
    usagePct: 13,
    subscriptionStatus: "active",
    ...over,
  }
}

const ORIGINAL: TeamSettingsOriginal = {
  planId: "plan_growth",
  customSeatPrice: 75,
  maxSeats: 10,
  status: "active",
}

const form = (over: Partial<TeamSettingsForm> = {}): TeamSettingsForm => ({
  planId: "plan_growth",
  customSeatPrice: "75",
  maxSeats: "10",
  status: "active",
  ...over,
})

describe("filterMembers", () => {
  const roster = [
    member({ userId: "u1", userName: "Alice Smith", userEmail: "alice@acme.io" }),
    member({ userId: "u2", userName: "Bob Jones", userEmail: "bob@acme.io" }),
    member({ userId: "zz9", userName: null, userEmail: null }),
  ]

  it("returns everyone for an empty / whitespace query", () => {
    expect(filterMembers(roster, "")).toHaveLength(3)
    expect(filterMembers(roster, "   ")).toHaveLength(3)
  })

  it("matches name, email and userId case-insensitively", () => {
    expect(filterMembers(roster, "alice").map((m) => m.userId)).toEqual(["u1"])
    expect(filterMembers(roster, "BOB@ACME").map((m) => m.userId)).toEqual(["u2"])
    expect(filterMembers(roster, "zz9").map((m) => m.userId)).toEqual(["zz9"])
  })

  it("returns none when nothing matches", () => {
    expect(filterMembers(roster, "nobody")).toEqual([])
  })
})

describe("usageColor", () => {
  it("maps the threshold bands", () => {
    expect(usageColor(null)).toBe("#71717A")
    expect(usageColor(0)).toBe("#06B6D4")
    expect(usageColor(79)).toBe("#06B6D4")
    expect(usageColor(80)).toBe("#FBBF24") // MUST BITE: an off-by-one band shows cyan
    expect(usageColor(99)).toBe("#FBBF24")
    expect(usageColor(100)).toBe("#F87171")
    expect(usageColor(140)).toBe("#F87171")
  })
})

describe("memberHoursLabel", () => {
  it("formats metered / unmetered / no-sub", () => {
    expect(memberHoursLabel(10, 80)).toBe("10/80h")
    expect(memberHoursLabel(5, 0)).toBe("5h")
    expect(memberHoursLabel(null, null)).toBe("—")
    expect(memberHoursLabel(10, null)).toBe("—")
  })
})

describe("teamToForm / teamToOriginal", () => {
  it("seeds the form from a team, mapping a null override to an empty field", () => {
    expect(
      teamToForm({ planId: "plan_pro", customSeatPrice: null, maxSeats: 10, status: "active" }),
    ).toEqual({
      planId: "plan_pro",
      customSeatPrice: "",
      maxSeats: "10",
      status: "active",
    })
    expect(
      teamToForm({ planId: "plan_pro", customSeatPrice: 75, maxSeats: 5, status: "paused" }),
    ).toEqual({
      planId: "plan_pro",
      customSeatPrice: "75",
      maxSeats: "5",
      status: "paused",
    })
  })

  it("a freshly-seeded form produces no changes against its own team", () => {
    const team = {
      planId: "plan_growth",
      customSeatPrice: 75,
      maxSeats: 10,
      status: "active" as const,
    }
    expect(buildTeamSettingsPayload("t1", teamToForm(team), teamToOriginal(team))).toEqual({
      teamId: "t1",
    })
  })
})

describe("buildTeamSettingsPayload", () => {
  it("includes only the teamId when nothing changed", () => {
    expect(buildTeamSettingsPayload("t1", form(), ORIGINAL)).toEqual({ teamId: "t1" })
  })

  it("includes a changed plan", () => {
    expect(buildTeamSettingsPayload("t1", form({ planId: "plan_pro" }), ORIGINAL)).toEqual({
      teamId: "t1",
      planId: "plan_pro",
    })
  })

  it("clears the override when the seat-price field is emptied", () => {
    // MUST BITE: dropping the empty→null branch would never clear the override.
    expect(buildTeamSettingsPayload("t1", form({ customSeatPrice: "" }), ORIGINAL)).toEqual({
      teamId: "t1",
      customSeatPrice: null,
    })
  })

  it("sets a new finite seat-price override", () => {
    expect(buildTeamSettingsPayload("t1", form({ customSeatPrice: "50" }), ORIGINAL)).toEqual({
      teamId: "t1",
      customSeatPrice: 50,
    })
  })

  it("omits the seat-price when unchanged", () => {
    expect(buildTeamSettingsPayload("t1", form({ customSeatPrice: "75" }), ORIGINAL)).toEqual({
      teamId: "t1",
    })
  })

  it("omits junk seat-price input instead of clobbering with NaN/negative", () => {
    expect(buildTeamSettingsPayload("t1", form({ customSeatPrice: "abc" }), ORIGINAL)).toEqual({
      teamId: "t1",
    })
    expect(buildTeamSettingsPayload("t1", form({ customSeatPrice: "-5" }), ORIGINAL)).toEqual({
      teamId: "t1",
    })
  })

  it("clears the override only when it was actually set", () => {
    // original already null → an empty field is a no-op, not a redundant clear.
    expect(
      buildTeamSettingsPayload("t1", form({ customSeatPrice: "" }), {
        ...ORIGINAL,
        customSeatPrice: null,
      }),
    ).toEqual({ teamId: "t1" })
  })

  it("includes changed maxSeats (floored) and status", () => {
    expect(
      buildTeamSettingsPayload("t1", form({ maxSeats: "20.7", status: "paused" }), ORIGINAL),
    ).toEqual({ teamId: "t1", maxSeats: 20, status: "paused" })
  })

  it("omits an invalid maxSeats", () => {
    expect(buildTeamSettingsPayload("t1", form({ maxSeats: "0" }), ORIGINAL)).toEqual({
      teamId: "t1",
    })
    expect(buildTeamSettingsPayload("t1", form({ maxSeats: "x" }), ORIGINAL)).toEqual({
      teamId: "t1",
    })
  })
})
