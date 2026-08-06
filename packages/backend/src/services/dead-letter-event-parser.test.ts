/**
 * Tests for the dead-letter event parser (A1.6 / TER-675).
 *
 * The bug: replaying with a plain `JSON.parse` reinserts Date fields as STRINGS,
 * so the TTL index never expires them and date-range queries never match. These
 * tests assert the round-trip `writer JSON.stringify → parseDeadLetterEvent`
 * yields real `Date` instances equal to the originals — a reviver that returns
 * the raw string (the bug) fails `instanceof Date`.
 */

import { describe, expect, it } from "bun:test"
import type { AgentUsageEvent } from "../types/database.js"
import { deadLetterDateReviver, parseDeadLetterEvent } from "./dead-letter-event-parser.js"

describe("deadLetterDateReviver — strict ISO-8601 → Date", () => {
  it("revives a full ISO instant (Z)", () => {
    const v = deadLetterDateReviver("appliedAt", "2026-07-08T07:00:05.912Z")
    expect(v).toBeInstanceOf(Date)
    expect((v as Date).toISOString()).toBe("2026-07-08T07:00:05.912Z")
  })

  it("revives an ISO instant with a numeric offset", () => {
    const v = deadLetterDateReviver("startedAt", "2026-07-08T09:00:00+02:00")
    expect(v).toBeInstanceOf(Date)
    expect((v as Date).getTime()).toBe(Date.parse("2026-07-08T07:00:00Z"))
  })

  it("leaves non-timestamp strings untouched (no false positives)", () => {
    // Ids, plain dates without a time/zone, and prose must NOT become Dates.
    expect(deadLetterDateReviver("eventId", "usess_41809bb5")).toBe("usess_41809bb5")
    expect(deadLetterDateReviver("d", "2026-07-08")).toBe("2026-07-08") // date only, no T/zone
    expect(deadLetterDateReviver("s", "not a date")).toBe("not a date")
    expect(deadLetterDateReviver("n", 42)).toBe(42)
  })
})

describe("parseDeadLetterEvent — round-trips the writer's JSON.stringify", () => {
  it("rehydrates appliedAt + payload dates as real Date instances", () => {
    const appliedAt = new Date("2026-07-08T07:00:05.912Z")
    const startedAt = new Date("2026-07-08T07:00:05.900Z")
    const original = {
      eventId: "evt_abc",
      sessionUsageId: "usess_1",
      type: "session.started",
      appliedAt,
      schemaVersion: 1,
      payload: { startedAt },
    } as unknown as AgentUsageEvent

    // The exact serialisation the DeadLetterFileWriter emits.
    const line = JSON.stringify(original)
    const parsed = parseDeadLetterEvent(line) as Extract<
      AgentUsageEvent,
      { type: "session.started" }
    >

    expect(parsed.appliedAt).toBeInstanceOf(Date)
    expect((parsed.appliedAt as Date).getTime()).toBe(appliedAt.getTime())
    expect(parsed.payload.startedAt).toBeInstanceOf(Date)
    expect((parsed.payload.startedAt as Date).getTime()).toBe(startedAt.getTime())
    // Non-date scalars survive unchanged.
    expect(parsed.eventId).toBe("evt_abc")
    expect(parsed.type).toBe("session.started")
  })
})
