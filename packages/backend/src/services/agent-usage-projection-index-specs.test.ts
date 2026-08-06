/**
 * Tests for the projection index specs the shadow rebuild recreates (A1.3 / TER-675).
 *
 * Structural invariants (lint-as-test): every rebuildable projection collection
 * MUST keep its unique key and its TTL, or a shadow rebuild silently breaks
 * idempotency / never expires docs. Dropping one from the specs fails the build.
 * The `ensureProjectionIndexes` test asserts the EXACT createIndex payload so a
 * mutated key/option is caught.
 */

import { describe, expect, it } from "bun:test"
import type { Db } from "mongodb"
import {
  EVENT_APPLICATIONS_INDEX_SPECS,
  ensureProjectionIndexes,
  PROJECTION_INDEX_SPECS,
  SESSIONS_INDEX_SPECS,
  TOOL_EXECUTIONS_INDEX_SPECS,
} from "./agent-usage-projection-index-specs.js"

describe("critical unique + TTL invariants per collection", () => {
  const cases = [
    { specs: SESSIONS_INDEX_SPECS, unique: "sessionUsageId_unique", ttlKey: "createdAt" },
    { specs: TOOL_EXECUTIONS_INDEX_SPECS, unique: "toolExecutionId_unique", ttlKey: "createdAt" },
    { specs: EVENT_APPLICATIONS_INDEX_SPECS, unique: "eventId_unique", ttlKey: "projectedAt" },
  ]

  for (const c of cases) {
    it(`keeps ${c.unique} (unique) and a TTL on ${c.ttlKey}`, () => {
      const unique = c.specs.find((s) => s.options.name === c.unique)
      expect(unique?.options.unique).toBe(true)

      const ttl = c.specs.find((s) => s.options.name === "ttl_180d")
      expect(ttl).toBeDefined()
      expect(typeof ttl?.options.expireAfterSeconds).toBe("number")
      expect(ttl?.key).toEqual({ [c.ttlKey]: 1 })
    })
  }

  it("the recreation set is exactly the three rebuildable projections", () => {
    expect(Object.keys(PROJECTION_INDEX_SPECS).sort()).toEqual([
      "agent_usage_event_applications",
      "agent_usage_sessions",
      "tool_executions",
    ])
  })
})

describe("ensureProjectionIndexes applies every spec via createIndex", () => {
  it("calls createIndex once per spec with the exact key + options", async () => {
    const calls: { collection: string; key: unknown; options: unknown }[] = []
    const fakeDb = {
      collection(name: string) {
        return {
          async createIndex(key: unknown, options: unknown) {
            calls.push({ collection: name, key, options })
            return "ok"
          },
        }
      },
    } as unknown as Db

    const applied = await ensureProjectionIndexes(fakeDb)

    const expectedTotal =
      SESSIONS_INDEX_SPECS.length +
      TOOL_EXECUTIONS_INDEX_SPECS.length +
      EVENT_APPLICATIONS_INDEX_SPECS.length
    expect(applied).toBe(expectedTotal)
    expect(calls).toHaveLength(expectedTotal)

    // The sessions unique key must be applied verbatim to the right collection.
    const sessionsUnique = calls.find(
      (c) => (c.options as { name?: string }).name === "sessionUsageId_unique",
    )
    expect(sessionsUnique?.collection).toBe("agent_usage_sessions")
    expect(sessionsUnique?.key).toEqual({ sessionUsageId: 1 })
    expect(sessionsUnique?.options).toEqual({ unique: true, name: "sessionUsageId_unique" })
  })
})
