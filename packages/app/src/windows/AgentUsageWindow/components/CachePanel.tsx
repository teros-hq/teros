/**
 * Cache panel — prompt-cache hit ratio and savings, per provider and per agent.
 * Honest degradation: a provider whose `cacheSupport` is `off` (Teros doesn't
 * send cache_control / doesn't extract cached tokens) shows "not measured",
 * NOT a misleading 0 % — that is the majority of providers today.
 */

import { Text, XStack } from "tamagui"
import {
  type Column,
  DataTable,
  fmtCount,
  SectionCard,
  tokens,
} from "../../../components/monitoring"
import type { CacheAgentRow, CacheMetrics, CacheProviderRow } from "../cache"
import { HBar, PanelNote, Stat } from "./panelBits"

const pct = (n: number) => `${n.toFixed(1)}%`

export function CachePanel({ cache, atFetchLimit = false }: { cache: CacheMetrics; atFetchLimit?: boolean }) {
  // Three-way gate (P2): "no sessions" ≠ "sessions whose usage wasn't
  // measured" ≠ "measured data". The old gate (totalIngested <= 0) claimed
  // "No token activity" while the sessions table listed live sessions —
  // every real historical session has inputTokens=0 (pre-fix telemetry).
  if (cache.sessionsCount === 0) {
    return <PanelNote>No sessions in this range.</PanelNote>
  }
  if (cache.measuredSessions === 0) {
    return (
      <PanelNote tone="warn">
        {`Token usage wasn't measured for any of the ${cache.sessionsCount} sessions in this range (they predate the telemetry fix, or their provider doesn't report usage) — cache can't be derived.`}
      </PanelNote>
    )
  }

  const measuredRead = cache.perProvider.some((p) => p.cacheSupport !== "off" && p.cacheRead > 0)

  const providerColumns: Column<CacheProviderRow>[] = [
    { key: "provider", header: "Provider", width: 160, align: "left", render: (p) => p.providerLabel },
    { key: "sessions", header: "Sessions", width: 84, align: "right", mono: true, render: (p) => fmtCount(p.sessions) },
    { key: "input", header: "Input", width: 96, align: "right", mono: true, render: (p) => (p.measuredSessions === 0 ? "—" : fmtCount(p.input)) },
    {
      key: "cacheread",
      header: "Cache read",
      width: 100,
      align: "right",
      mono: true,
      render: (p) => (p.cacheSupport === "off" || p.measuredSessions === 0 ? "—" : fmtCount(p.cacheRead)),
    },
    {
      key: "hit",
      header: "Hit ratio",
      width: 150,
      flex: 1,
      align: "left",
      render: (p) =>
        p.cacheSupport === "off" || p.measuredSessions === 0 ? (
          <Text fontSize={12} color={tokens.textTertiary} fontStyle="italic">
            not measured here
          </Text>
        ) : (
          <XStack ai="center" gap={8} flex={1}>
            <HBar value={p.hitRatio / 100} color={tokens.success} />
            <Text fontSize={12} fontFamily="$mono" color={tokens.textSecondary} width={48} textAlign="right">
              {pct(p.hitRatio)}
            </Text>
          </XStack>
        ),
    },
  ]

  const agentColumns: Column<CacheAgentRow>[] = [
    { key: "agent", header: "Agent", width: 200, flex: 1, align: "left", render: (a) => a.agentName },
    { key: "input", header: "Input", width: 100, align: "right", mono: true, render: (a) => fmtCount(a.input) },
    { key: "read", header: "Cache read", width: 110, align: "right", mono: true, render: (a) => fmtCount(a.cacheRead) },
    { key: "hit", header: "Hit ratio", width: 90, align: "right", mono: true, render: (a) => pct(a.hitRatio) },
  ]

  return (
    <>
      <SectionCard title="Cache overview">
        <XStack gap={36} flexWrap="wrap">
          <Stat
            label="Hit ratio"
            value={measuredRead ? pct(cache.cacheHitRatio) : "—"}
            sub={measuredRead ? "input served from cache" : "not measured for these providers"}
            color={measuredRead ? tokens.success : tokens.textTertiary}
          />
          <Stat label="Cache read" value={fmtCount(cache.totalCacheRead)} sub="tokens read from cache" />
          <Stat label="Cache write" value={fmtCount(cache.totalCacheWrite)} sub="tokens written (future savings)" />
        </XStack>
        {!measuredRead ? (
          <PanelNote tone="warn">
            Cache is not measured for the providers in this range (Teros doesn't extract cached tokens for them yet).
          </PanelNote>
        ) : null}
        {cache.unmeasuredSessions > 0 ? (
          <PanelNote>
            {`${cache.unmeasuredSessions} of ${cache.sessionsCount} sessions carry no measured usage (pre-fix telemetry or provider gap) and are excluded from the ratios.`}
          </PanelNote>
        ) : null}
        {atFetchLimit ? (
          <PanelNote>{`Computed over the ${cache.sessionsCount} most recent sessions in the range.`}</PanelNote>
        ) : null}
      </SectionCard>

      <SectionCard title="By provider">
        <DataTable columns={providerColumns} rows={cache.perProvider} rowKey={(p) => p.provider} />
      </SectionCard>

      {/* per-agent only when SOME cache was actually measured — otherwise every
          row is a misleading 0 % (agents span providers, so we can't tag them
          "not measured" individually). */}
      {cache.totalCacheRead > 0 && cache.perAgent.length > 0 ? (
        <SectionCard title="By agent">
          <DataTable columns={agentColumns} rows={cache.perAgent} rowKey={(a) => a.agentId} />
        </SectionCard>
      ) : null}
    </>
  )
}
