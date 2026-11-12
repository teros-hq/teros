/**
 * useChannelAgentHours — the ONE data path for every agent-hours surface
 * (WS2): chat header chip, conversations list row, task card badge, task
 * detail row. All four must show the same numbers the quota discounts, so
 * they all read from the same batch endpoint (`user-api.my-usage-channels-
 * summary`) through this module — no surface fetches on its own.
 *
 * Cache design (module-level, shared across surfaces):
 *   - `cache`: channelId → { workMs, sessions } + fetchedAt. A channel already
 *     loaded by another surface is served instantly — the header chip and the
 *     task detail of the SAME conversation never double-fetch.
 *   - `inflight`: channelId → Promise. Concurrent mounts dedupe into one call.
 *   - TTL 60s: the tracker bills CLOSED hour buckets, so numbers lag by up to
 *     ~1h anyway — a short TTL re-syncs without hammering the endpoint on
 *     every re-render.
 *
 * Numbers are SUM semantics (decision #29): parallel agents each burn quota,
 * so two overlapping 10-min sessions read 20 min — never the union.
 */

import { useEffect, useRef, useState } from "react"
import { formatAgentDuration } from "@teros/shared"
import { getTerosClient } from "../services/terosClientSingleton"
import type { ChannelAgentHours } from "../services/UserApi"

/** How long a cached channel keeps answering before the next fetch refreshes. */
const CACHE_TTL_MS = 60_000

interface CacheEntry extends ChannelAgentHours {
  fetchedAt: number
}

/** Module-level cache — shared by every surface using the hook. */
const cache = new Map<string, CacheEntry>()

/** In-flight batch promises, keyed by a stable join of the requested ids. */
const inflight = new Map<string, Promise<void>>()

function keyFor(channelIds: string[]): string {
  return [...channelIds].sort().join(",")
}

/**
 * Fetch (or refresh) a batch of channels. Serves everything already cached
 * and un-expired without a network call; only the missing/stale ids are
 * requested. Multiple concurrent calls with the same id-set dedupe.
 */
async function ensureChannels(channelIds: string[], force = false): Promise<void> {
  const now = Date.now()
  const needed = channelIds.filter((id) => {
    const hit = cache.get(id)
    return force || !hit || now - hit.fetchedAt > CACHE_TTL_MS
  })
  if (needed.length === 0) return

  const key = keyFor(needed)
  const existing = inflight.get(key)
  if (existing) return existing

  const p = (async () => {
    try {
      const client = getTerosClient()
      const res = await client.user.myUsageChannelsSummary(needed)
      const fetchedAt = Date.now()
      for (const id of needed) {
        const entry = res.channels[id]
        // Absent channel = no billable use this period → 0, cached like any
        // other value so it doesn't refetch on every mount.
        cache.set(id, {
          workMs: entry?.workMs ?? 0,
          sessions: entry?.sessions ?? 0,
          fetchedAt,
        })
      }
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  return p
}

/** The current cached value for one channel (or undefined while loading). */
function readChannel(channelId: string): ChannelAgentHours | undefined {
  const hit = cache.get(channelId)
  if (!hit) return undefined
  return { workMs: hit.workMs, sessions: hit.sessions }
}

export interface UseChannelAgentHoursResult {
  /** Billable work in the channel this period, ms (0 once loaded). */
  workMs: number
  /** Billable sessions this period. */
  sessions: number
  /** `formatAgentDuration(workMs)` — e.g. "2.3h". Ready for display. */
  formatted: string
  /** False until the first load for this channel has settled. */
  loading: boolean
}

/**
 * Agent-hours of ONE channel (the conversation the user has open, or the
 * conversation linked to a task). `undefined`/empty channelId → inert result
 * (no fetch, loading:false) so callers can render unconditionally.
 */
export function useChannelAgentHours(channelId?: string | null): UseChannelAgentHoursResult {
  const [entry, setEntry] = useState<ChannelAgentHours | undefined>(() =>
    channelId ? readChannel(channelId) : undefined,
  )
  const [loading, setLoading] = useState<boolean>(() => {
    if (!channelId) return false
    return cache.get(channelId) === undefined
  })

  useEffect(() => {
    if (!channelId) {
      setEntry(undefined)
      setLoading(false)
      return
    }
    let cancelled = false
    const cached = readChannel(channelId)
    setEntry(cached)
    setLoading(cached === undefined)
    ensureChannels([channelId])
      .then(() => {
        if (cancelled) return
        setEntry(readChannel(channelId))
        setLoading(false)
      })
      .catch(() => {
        // Surface stays silent on failure — the chip is informational, not
        // critical. Next mount retries after TTL.
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [channelId])

  const workMs = entry?.workMs ?? 0
  return {
    workMs,
    sessions: entry?.sessions ?? 0,
    formatted: formatAgentDuration(workMs),
    loading,
  }
}

/**
 * Agent-hours of MANY channels in ONE batch (the conversations list). One
 * call for the whole list — never N per-row calls. Returns a map of formatted
 * strings + raw entries keyed by channelId; rows read their own entry.
 */
export function useChannelsAgentHours(channelIds: string[]): {
  byChannel: Record<string, ChannelAgentHours>
  loading: boolean
} {
  const stableIds = [...channelIds].sort().join(",")
  const [byChannel, setByChannel] = useState<Record<string, ChannelAgentHours>>(() => {
    const out: Record<string, ChannelAgentHours> = {}
    for (const id of channelIds) {
      const hit = readChannel(id)
      if (hit) out[id] = hit
    }
    return out
  })
  const [loading, setLoading] = useState(true)
  const idsRef = useRef<string[]>(channelIds)

  useEffect(() => {
    idsRef.current = channelIds
  }, [stableIds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!channelIds.length) {
      setByChannel({})
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    ensureChannels(channelIds)
      .then(() => {
        if (cancelled) return
        const out: Record<string, ChannelAgentHours> = {}
        for (const id of idsRef.current) out[id] = readChannel(id) ?? { workMs: 0, sessions: 0 }
        setByChannel(out)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [stableIds]) // eslint-disable-line react-hooks/exhaustive-deps

  return { byChannel, loading }
}

/** Test seam: wipe the module cache between tests. */
export function __resetChannelAgentHoursCacheForTests(): void {
  cache.clear()
  inflight.clear()
}
