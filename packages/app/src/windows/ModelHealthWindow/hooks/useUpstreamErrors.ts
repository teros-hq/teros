/**
 * useUpstreamErrors (TER-700) — loads the recent upstream provider-error feed for
 * the Model Health window, scoped to the same range + logical provider as the
 * rest of the dashboard. Ops-only: carries the precise `errorSubReason` + the
 * literal `upstreamMessage` the end user never sees.
 */
import { useCallback, useEffect, useState } from "react"
import type { AgentUsageProvider, UpstreamErrorRow } from "../../../services/AdminApi"
import type { TerosClient } from "../../../services/TerosClient"

interface UseUpstreamErrorsArgs {
  client: TerosClient
  range: { from: string; to: string }
  provider?: AgentUsageProvider
}

export interface UseUpstreamErrorsResult {
  rows: UpstreamErrorRow[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useUpstreamErrors({
  client,
  range,
  provider,
}: UseUpstreamErrorsArgs): UseUpstreamErrorsResult {
  const [rows, setRows] = useState<UpstreamErrorRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await client.admin.agentUsageUpstreamErrors({
        from: range.from,
        to: range.to,
        ...(provider ? { provider } : {}),
        limit: 50,
      })
      setRows(res.items)
      setLoading(false)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      setError(
        code === "FORBIDDEN"
          ? "Admin privileges required"
          : (err as { message?: string })?.message || "Failed to load",
      )
      setLoading(false)
    }
  }, [client, range, provider])

  useEffect(() => {
    void load()
  }, [load])

  return { rows, loading, error, refresh: load }
}
