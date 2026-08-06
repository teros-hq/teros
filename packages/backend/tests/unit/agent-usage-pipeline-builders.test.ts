/**
 * Exact-payload tests for the agent-usage pipeline builders (A7.3 / TER-673).
 *
 * The builders turn a parsed query into the Mongo filter/pipeline. Asserting the
 * EXACT shape (toEqual, not "contains") catches a dropped/renamed clause that
 * would silently broaden or empty a cross-tenant query — the class A7.3 flags,
 * e.g. tool-executions never scoping by provider, or the userActive branch
 * dropping agentId/provider.
 */

import { describe, expect, it } from "bun:test"
import {
  buildSessionsListPipeline,
  buildTokensPerHourPipeline,
  buildToolExecutionsListPipeline,
  parseQuery,
} from "../../src/services/agent-usage-query-helper"

const FROM = "2026-05-01T00:00:00Z"
const TO = "2026-05-19T00:00:00Z"
const from = new Date(FROM)
const to = new Date(TO)

const q = (over: Record<string, unknown>) =>
  parseQuery({ from: FROM, to: TO, ...over }, { allowEmptyFilters: true })

describe("buildSessionsListPipeline", () => {
  it("emits every scoping clause when all filters are present", () => {
    const { filter, limit, skip } = buildSessionsListPipeline(
      q({
        userId: "user_1",
        agentId: "agent_1",
        workspaceId: "work_1",
        provider: "teros",
        triggerKind: "user_message",
        statuses: ["completed", "errored"],
        limit: 25,
        skip: 10,
      }),
    )
    expect(filter).toEqual({
      demoSeed: { $ne: true },
      startedAt: { $gte: from, $lt: to },
      userId: "user_1",
      agentId: "agent_1",
      workspaceId: "work_1",
      provider: "teros",
      triggerKind: "user_message",
      status: { $in: ["completed", "errored"] },
    })
    expect(limit).toBe(25)
    expect(skip).toBe(10)
  })

  it("omits absent filters (only the range remains)", () => {
    const { filter } = buildSessionsListPipeline(q({}))
    expect(filter).toEqual({ demoSeed: { $ne: true }, startedAt: { $gte: from, $lt: to } })
  })

  it("does not set status when statuses is empty", () => {
    const { filter } = buildSessionsListPipeline(q({ userId: "user_1", statuses: [] }))
    expect(filter).toEqual({ demoSeed: { $ne: true }, startedAt: { $gte: from, $lt: to }, userId: "user_1" })
  })
})

describe("buildToolExecutionsListPipeline", () => {
  it("scopes ONLY by range + user/agent/workspace — never provider/trigger/status", () => {
    // tool_executions carry no provider/triggerKind/status filter dimension.
    // Passing them must NOT leak into the filter (they are dropped by design).
    const { filter } = buildToolExecutionsListPipeline(
      q({
        userId: "user_1",
        agentId: "agent_1",
        workspaceId: "work_1",
        provider: "teros",
        triggerKind: "user_message",
        statuses: ["completed"],
      }),
    )
    expect(filter).toEqual({
      demoSeed: { $ne: true },
      startedAt: { $gte: from, $lt: to },
      userId: "user_1",
      agentId: "agent_1",
      workspaceId: "work_1",
    })
  })
})

describe("buildTokensPerHourPipeline — userActive drops agentId/provider from $match (A7.3)", () => {
  function matchStage(pipeline: object[]): Record<string, unknown> {
    const stage = pipeline.find((s) => "$match" in s) as { $match: Record<string, unknown> }
    return stage.$match
  }

  it("agentActive scopes by all four group-key dims", () => {
    const match = matchStage(
      buildTokensPerHourPipeline(
        q({
          userId: "u",
          agentId: "a",
          workspaceId: "w",
          provider: "teros",
          timeMetric: "agentActive",
        }),
      ),
    )
    expect(match).toEqual({
      demoSeed: { $ne: true },
      hourBucket: { $gte: from, $lt: to },
      "groupKey.userId": "u",
      "groupKey.workspaceId": "w",
      "groupKey.agentId": "a",
      "groupKey.provider": "teros",
    })
  })

  it("userActive intentionally ignores agentId/provider (latent no-op — documented)", () => {
    const match = matchStage(
      buildTokensPerHourPipeline(
        q({
          userId: "u",
          agentId: "a",
          workspaceId: "w",
          provider: "teros",
          timeMetric: "userActive",
        }),
      ),
    )
    // agentId/provider are NOT applied for the user-metric rollup.
    expect(match).toEqual({
      demoSeed: { $ne: true },
      hourBucket: { $gte: from, $lt: to },
      "groupKey.userId": "u",
      "groupKey.workspaceId": "w",
    })
  })
})
