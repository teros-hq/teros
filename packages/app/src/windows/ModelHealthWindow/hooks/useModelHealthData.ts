/**
 * `useModelHealthData()` — fetch lifecycle for the model-health window
 * (TER-616 / F1). One WS query (`admin-api.agent-usage-model-health`) scoped by
 * the period selector + optional logical-provider filter. Loads on mount, on
 * reconnect, and via `refresh()`. Mirrors `useAgentUsageData`'s connection
 * handling and the FORBIDDEN → "Admin privileges required" mapping.
 */

import { useCallback, useEffect, useState } from "react"
import type {
  AgentUsageProvider,
  ModelHealthHourBucket,
  ModelHealthSummary,
  UpstreamStatus,
} from "../../../services/AdminApi"
import type { TerosClient } from "../../../services/TerosClient"

export interface UseModelHealthDataArgs {
  client: TerosClient
  /** ISO-8601 from/to range. */
  range: { from: string; to: string }
  /** Logical provider filter (e.g. `teros`); the response still splits by upstream. */
  provider?: AgentUsageProvider
  /**
   * Dimensional scope (2026-07-07 audit, P4/N5): the backend match already
   * supports these; without them the By-model table and request chart ignored
   * the FilterBar entirely.
   */
  userId?: string
  agentId?: string
  workspaceId?: string
  /** Bucket unit for the time-series ('day' for 7d/30d — P5). Default hour. */
  groupBy?: "hour" | "day"
}

export interface UseModelHealthDataResult {
  models: ModelHealthSummary[]
  /** Hourly time-series for the trend chart (F1.2). */
  series: ModelHealthHourBucket[]
  /** IANA tz label the hourly buckets should be rendered in (F1.2). */
  bucketTimeZone: string
  /** Length of the window in minutes — denominator for the global throughput KPI (F1.1). */
  periodMinutes: number
  /** Upstream status-page indicators for the incident badge (R9). */
  upstreamStatus?: UpstreamStatus
  loading: boolean
  refreshing: boolean
  error: string | null
  lastRefreshedAt: number | null
  refresh: () => void
}

export function useModelHealthData(args: UseModelHealthDataArgs): UseModelHealthDataResult {
  const { client, range, provider, userId, agentId, workspaceId, groupBy } = args
  const [models, setModels] = useState<ModelHealthSummary[]>([])
  const [series, setSeries] = useState<ModelHealthHourBucket[]>([])
  const [bucketTimeZone, setBucketTimeZone] = useState<string>("UTC")
  const [periodMinutes, setPeriodMinutes] = useState<number>(0)
  const [upstreamStatus, setUpstreamStatus] = useState<UpstreamStatus | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setRefreshing(true)
    try {
      const params = {
        from: range.from,
        to: range.to,
        ...(provider ? { provider } : {}),
        ...(userId ? { userId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(groupBy ? { groupBy } : {}),
        limit: 500,
        skip: 0,
      }
      // Both come from the same rollup collection + auth, so they share one
      // lifecycle: if the subsystem is down, both fail together (vs the in-flight
      // gauge, which has its own polling because it's a real-time signal).
      const [res, ts] = await Promise.all([
        client.admin.agentUsageModelHealth(params),
        client.admin.agentUsageModelHealthTimeseries(params),
      ])
      setModels(res.models)
      setPeriodMinutes(res.periodMinutes)
      setUpstreamStatus(res.upstreamStatus)
      setSeries(ts.series)
      setBucketTimeZone(ts.bucketTimeZone)
      setLastRefreshedAt(Date.now())
      setLoading(false)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      setError(
        code === "FORBIDDEN"
          ? "Admin privileges required"
          : (err as { message?: string })?.message || "Failed to load",
      )
      setLoading(false)
    } finally {
      setRefreshing(false)
    }
  }, [client, range, provider, userId, agentId, workspaceId, groupBy])

  const refresh = useCallback(() => {
    load()
  }, [load])

  useEffect(() => {
    if (client.isConnected()) {
      load()
      return
    }
    const onConnected = () => {
      load()
      client.off("connected", onConnected)
    }
    client.on("connected", onConnected)
    return () => {
      client.off("connected", onConnected)
    }
  }, [client, load])

  return {
    models,
    series,
    bucketTimeZone,
    periodMinutes,
    upstreamStatus,
    loading,
    refreshing,
    error,
    lastRefreshedAt,
    refresh,
  }
}
