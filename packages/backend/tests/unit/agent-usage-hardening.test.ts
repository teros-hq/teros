/**
 * TER-675 hardening: the catch-up window is env-configurable, and every admin
 * agent-usage query carries a maxTimeMS ceiling; the live-hour fold reads a
 * projection instead of full 1 KB docs.
 */
import { describe, expect, it } from "bun:test"
import { resolveCatchUpHours } from "../../src/services/agent-usage-rollup-job"
import { createAgentUsageModelHealthHandler } from "../../src/handlers/domains/admin-api/agent-usage"
import type { WsHandlerContext } from "@teros/shared"

describe("resolveCatchUpHours (A1.7)", () => {
  // Default raised 24 -> 72 in the TER-650 merge: proactive headroom so a >24h
  // (weekend) outage doesn't drop un-billed hour buckets — a silent revenue leak.
  // Configurability (ROLLUP_CATCHUP_HOURS) is unchanged; only the default moved.
  it("defaults to 72 when unset or invalid", () => {
    expect(resolveCatchUpHours({} as any)).toBe(72)
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "abc" } as any)).toBe(72)
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "0" } as any)).toBe(72)
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "-5" } as any)).toBe(72)
  })
  it("honours a valid override, floored", () => {
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "72" } as any)).toBe(72)
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "48.9" } as any)).toBe(48)
  })
  it("clamps a runaway value to 720h (30d)", () => {
    expect(resolveCatchUpHours({ ROLLUP_CATCHUP_HOURS: "100000" } as any)).toBe(720)
  })
})

// A fake db that records the options each collection query receives, and returns
// empty results so the handler runs end-to-end without a real Mongo.
function capturingDb() {
  const captured: Record<string, { filter?: any; options?: any }[]> = {}
  const record = (name: string, filter?: any, options?: any) => {
    ;(captured[name] ??= []).push({ filter, options })
  }
  const chain = (name: string) => ({
    find(filter: any, options?: any) {
      record(`${name}.find`, filter, options)
      let opts = options ?? {}
      const cur = {
        sort: () => cur,
        skip: () => cur,
        limit: () => cur,
        maxTimeMS: (ms: number) => {
          opts = { ...opts, maxTimeMS: ms }
          record(`${name}.find.maxTimeMS`, filter, opts)
          return cur
        },
        toArray: async () => [],
      }
      return cur
    },
    async findOne(filter: any, options?: any) {
      record(`${name}.findOne`, filter, options)
      return name === "users" ? { userId: "u", role: "super" } : null
    },
    aggregate(_pipeline: any, options?: any) {
      record(`${name}.aggregate`, undefined, options)
      return { toArray: async () => [] }
    },
  })
  return {
    captured,
    db: { collection: (name: string) => chain(name) } as any,
  }
}

const ctx = (userId: string) => ({ userId, connectionId: "c", sessionId: "s" }) as WsHandlerContext

describe("admin agent-usage queries carry maxTimeMS + projection (A6.4/A4.4)", () => {
  it("model-health rollups read + live fold both set maxTimeMS; the live fold projects", async () => {
    const { db, captured } = capturingDb()
    const handler = createAgentUsageModelHealthHandler(db)
    // Range that includes the current hour so the live fold runs.
    const now = new Date()
    await handler(ctx("u"), {
      from: new Date(now.getTime() - 3_600_000).toISOString(),
      to: new Date(now.getTime() + 3_600_000).toISOString(),
    })

    // The rollups read runs through the merge PIPELINE (TER-668/674), not a flat
    // find, and still carries a maxTimeMS ceiling.
    const rollupAgg = captured["agent_usage_rollups_hourly.aggregate"] ?? []
    expect(rollupAgg.length).toBeGreaterThan(0)
    expect(rollupAgg[0].options.maxTimeMS).toBe(5000)

    // The live fold over sessions passed a projection AND a maxTimeMS (not a full
    // 1 KB doc scan). Mutation: dropping either turns this red.
    const sessFind = captured["agent_usage_sessions.find"] ?? []
    expect(sessFind.length).toBe(1)
    expect(sessFind[0].options?.projection).toBeDefined()
    expect(sessFind[0].options.projection.provider).toBe(1)
    const sessMax = captured["agent_usage_sessions.find.maxTimeMS"] ?? []
    expect(sessMax[0].options.maxTimeMS).toBe(5000)
  })
})
