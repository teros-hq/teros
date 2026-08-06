/**
 * Cache & savings derivations for Agent Activity — pure, testable functions
 * lifted from the legacy God-component (git 5dc70875~1). Per-agent and
 * per-provider cache-hit aggregation from the loaded sessions.
 *
 * Cache status is sourced from the CANONICAL registry (`resolveProvider`), NOT
 * a local duplicate — after the backend cache-extraction fix (OpenAI/Gemini),
 * a hand-maintained PROVIDER_CACHE_STATUS map would drift. The panel degrades
 * honestly off `cacheSupport`: `off` → "cache not measured for this provider"
 * (the majority today) instead of a misleading 0 %.
 */

import { type CacheSupport, resolveProvider } from '@teros/shared'
import type { AgentUsageSessionSummary } from '../../services/AdminApi'

/**
 * A session whose usage the provider never reported (P2/N8): the backend
 * marks it `usagePartial`; older rows predate the flag, so a completed turn
 * with 0 tokens on both sides counts as unmeasured too. These sessions must
 * read "not measured" in the UI — never a real 0 or a fake 0 % ratio.
 */
export function isUsageUnmeasured(s: AgentUsageSessionSummary): boolean {
  return s.usagePartial === true || (s.inputTokens || 0) + (s.outputTokens || 0) === 0
}

export interface CacheAgentRow {
  agentId: string
  agentName: string
  input: number
  cacheRead: number
  cacheWrite: number
  sessions: number
  hitRatio: number
}

export interface CacheProviderRow {
  provider: string
  providerLabel: string
  input: number
  cacheRead: number
  cacheWrite: number
  sessions: number
  /** Sessions whose usage WAS reported — 0 means every token figure is a gap, not a zero. */
  measuredSessions: number
  costUsd: number
  hitRatio: number
  cacheSupport: CacheSupport
  cacheNote?: string
}

export interface CacheMetrics {
  totalInput: number
  totalCacheRead: number
  totalCacheWrite: number
  totalOutput: number
  /** input + cacheRead — the total prompt tokens ingested. */
  totalIngested: number
  totalCostUsd: number
  /** cacheRead / ingested × 100 across all sessions. */
  cacheHitRatio: number
  /** Sessions fed into these metrics (the loaded page, not the whole range). */
  sessionsCount: number
  /** Sessions whose usage the provider reported / didn't (P2/N8). */
  measuredSessions: number
  unmeasuredSessions: number
  perAgent: CacheAgentRow[]
  perProvider: CacheProviderRow[]
}

/** "% of input served from cache" — cacheRead / (input + cacheRead) × 100. */
export function cacheHitRatio(cacheRead: number, input: number): number {
  const ingested = input + cacheRead
  return ingested > 0 ? (cacheRead / ingested) * 100 : 0
}

/**
 * Aggregate cache usage from the loaded sessions. `cachedRead/WriteTokens` are
 * `0` when the provider/adapter doesn't populate them (a data gap, not a bug) —
 * the per-provider `cacheSupport` tells the UI whether that 0 means "no hits"
 * or "not measured here".
 */
export function cacheMetrics(
  sessions: AgentUsageSessionSummary[],
  agentIdToName: Map<string, string>,
): CacheMetrics {
  let totalInput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCostUsd = 0
  let totalOutput = 0
  const perAgent = new Map<
    string,
    { input: number; cacheRead: number; cacheWrite: number; sessions: number }
  >()
  const perProvider = new Map<
    string,
    { input: number; cacheRead: number; cacheWrite: number; sessions: number; measuredSessions: number; costUsd: number }
  >()

  let measuredSessions = 0
  for (const s of sessions) {
    const measured = !isUsageUnmeasured(s)
    if (measured) measuredSessions += 1
    const input = s.inputTokens || 0
    const cacheRead = s.cachedReadTokens || 0
    const cacheWrite = s.cachedWriteTokens || 0
    totalInput += input
    totalCacheRead += cacheRead
    totalCacheWrite += cacheWrite
    totalCostUsd += s.costUsd || 0
    totalOutput += s.outputTokens || 0

    const a = perAgent.get(s.agentId) ?? { input: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 }
    a.input += input
    a.cacheRead += cacheRead
    a.cacheWrite += cacheWrite
    a.sessions += 1
    perAgent.set(s.agentId, a)

    const p = perProvider.get(s.provider) ?? {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      sessions: 0,
      measuredSessions: 0,
      costUsd: 0,
    }
    p.input += input
    p.cacheRead += cacheRead
    p.cacheWrite += cacheWrite
    p.sessions += 1
    if (measured) p.measuredSessions += 1
    p.costUsd += s.costUsd || 0
    perProvider.set(s.provider, p)
  }

  const totalIngested = totalInput + totalCacheRead

  const perAgentArr: CacheAgentRow[] = [...perAgent.entries()]
    .map(([agentId, m]) => ({
      agentId,
      agentName: agentIdToName.get(agentId) ?? agentId,
      input: m.input,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      sessions: m.sessions,
      hitRatio: cacheHitRatio(m.cacheRead, m.input),
    }))
    .sort((a, b) => b.hitRatio - a.hitRatio)

  const perProviderArr: CacheProviderRow[] = [...perProvider.entries()]
    .map(([provider, m]) => {
      const meta = resolveProvider(provider)
      return {
        provider,
        providerLabel: meta.label,
        input: m.input,
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite,
        sessions: m.sessions,
        measuredSessions: m.measuredSessions,
        costUsd: m.costUsd,
        hitRatio: cacheHitRatio(m.cacheRead, m.input),
        cacheSupport: meta.cacheSupport,
        cacheNote: meta.cacheNote,
      }
    })
    .sort((a, b) => b.input + b.cacheRead - (a.input + a.cacheRead))

  return {
    totalInput,
    totalCacheRead,
    totalCacheWrite,
    totalOutput,
    totalIngested,
    totalCostUsd,
    cacheHitRatio: cacheHitRatio(totalCacheRead, totalInput),
    sessionsCount: sessions.length,
    measuredSessions,
    unmeasuredSessions: sessions.length - measuredSessions,
    perAgent: perAgentArr,
    perProvider: perProviderArr,
  }
}
