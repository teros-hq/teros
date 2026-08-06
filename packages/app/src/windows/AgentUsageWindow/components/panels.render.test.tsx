/**
 * Render tests for the detail panels — pin the HONEST-DEGRADATION invariant:
 * a provider that doesn't measure cache shows "not measured", never a fake 0 %;
 * empty datasets show an explicit note, not a blank/zeroed table.
 */

import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { AgentUsageSessionSummary } from "../../../services/AdminApi"
import { cacheMetrics } from "../cache"
import { quotaSnapshot } from "../quota"
import { CachePanel } from "./CachePanel"
import { QuotaPanel } from "./QuotaPanel"
import { ToolsPanel } from "./ToolsPanel"
import { TokensPanel } from "./TokensPanel"

function sess(provider: string, input: number, cachedReadTokens: number): AgentUsageSessionSummary {
  return {
    agentId: "a1",
    provider,
    modelId: "m",
    inputTokens: input,
    outputTokens: 0,
    cachedReadTokens,
    costUsd: 0,
  } as unknown as AgentUsageSessionSummary
}

const NAMES = new Map([["a1", "Agent One"]])

describe("CachePanel — honest degradation", () => {
  it("shows 'not measured here' for an off provider, never a fake 0 %", () => {
    const cache = cacheMetrics([sess("groq", 1000, 0)], NAMES) // groq = off (fireworks moved to `auto`, TER-666)
    const { getByText, queryByText } = renderWithTamagui(<CachePanel cache={cache} />)
    expect(getByText("not measured here")).toBeTruthy()
    expect(queryByText("0.0%")).toBeNull() // no fabricated ratio
  })

  it("shows the real ratio for a measuring provider", () => {
    const cache = cacheMetrics([sess("anthropic", 1500, 500)], NAMES) // active, 25%
    const { getAllByText } = renderWithTamagui(<CachePanel cache={cache} />)
    // 25.0% appears in the overview stat + the per-provider row + per-agent row.
    expect(getAllByText("25.0%").length).toBeGreaterThan(0)
  })
})

describe("CachePanel — three-way gate (P2)", () => {
  it("no sessions → 'No sessions in this range.'", () => {
    const { getByText } = renderWithTamagui(<CachePanel cache={cacheMetrics([], NAMES)} />)
    expect(getByText(/No sessions in this range/)).toBeTruthy()
  })

  it("sessions with unmeasured usage → says WHY, never 'No token activity'", () => {
    // Two real-world historical sessions: 0 tokens, no cache — the old gate
    // rendered "No token activity in this range." while sessions existed.
    const cache = cacheMetrics([sess("teros", 0, 0), sess("teros", 0, 0)], NAMES)
    const { getByText, queryByText } = renderWithTamagui(<CachePanel cache={cache} />)
    expect(getByText(/Token usage wasn't measured for any of the 2 sessions/)).toBeTruthy()
    expect(queryByText(/No token activity/)).toBeNull()
  })

  it("a provider with 0 measured sessions reads 'not measured here', not 0.0 %", () => {
    // anthropic measured (so the panel renders) + teros all-unmeasured.
    const cache = cacheMetrics([sess("anthropic", 1500, 500), sess("teros", 0, 0)], NAMES)
    const { getByText, queryByText } = renderWithTamagui(<CachePanel cache={cache} />)
    expect(getByText("not measured here")).toBeTruthy()
    expect(queryByText("0.0%")).toBeNull()
  })

  it("states the fetch cap when the page is at the limit", () => {
    const cache = cacheMetrics([sess("anthropic", 1500, 500)], NAMES)
    const { getByText } = renderWithTamagui(<CachePanel cache={cache} atFetchLimit />)
    expect(getByText(/Computed over the 1 most recent sessions/)).toBeTruthy()
  })
})

describe("TokensPanel — unmeasured vs provider gap (P3)", () => {
  it("all sessions unmeasured → telemetry-gap copy with the count", () => {
    const { getByText } = renderWithTamagui(<TokensPanel sessions={[sess("teros", 0, 0), sess("teros", 0, 0)]} />)
    expect(getByText(/Token usage wasn't measured for any of the 2 sessions/)).toBeTruthy()
  })

  it("mixed gaps → splits telemetry gap vs provider gap with counts", () => {
    const { getByText } = renderWithTamagui(
      <TokensPanel sessions={[sess("teros", 0, 0), sess("zhipu-coding", 900, 0)]} />,
    )
    expect(getByText(/1 had no usage measured/)).toBeTruthy()
    expect(getByText(/1 reported totals without per-category tokens/)).toBeTruthy()
  })
})

describe("QuotaPanel / ToolsPanel / TokensPanel — empty states", () => {
  it("QuotaPanel with no consumption shows an explicit note", () => {
    const quota = quotaSnapshot([], { userIdToName: new Map(), userIdToLimit: new Map() }, new Date("2026-07-15T00:00:00Z"))
    const { getByText } = renderWithTamagui(<QuotaPanel quota={quota} showInternalIds={false} />)
    expect(getByText(/No agent-hours consumed/)).toBeTruthy()
  })

  it("ToolsPanel with no executions shows an explicit note", () => {
    const { getByText } = renderWithTamagui(<ToolsPanel tools={[]} showInternalIds={false} onDrill={() => {}} />)
    expect(getByText(/No tool executions/)).toBeTruthy()
  })

  it("TokensPanel with a measured session but no breakdown states the provider gap", () => {
    const { getByText } = renderWithTamagui(<TokensPanel sessions={[sess("teros", 1000, 0)]} />)
    expect(getByText(/reported totals without per-category tokens/)).toBeTruthy()
  })
})
