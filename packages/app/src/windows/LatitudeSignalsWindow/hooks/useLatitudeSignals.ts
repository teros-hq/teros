/**
 * `useLatitudeSignals()` — fetch lifecycle for the F4·C2 signals dashboard.
 *
 * Loads `admin-api.latitude-signals-list`. The backend never rejects on a Latitude
 * problem — it carries a `status` (unconfigured / unauthorized / unreachable / ok)
 * that the UI renders as the right empty state; only an auth (FORBIDDEN) or a
 * genuine transport failure lands in `error`. Cursor pagination is append-based
 * ("Load more"); changing filters resets to page one.
 */

import { useCallback, useEffect, useState } from "react"
import type { LatitudeSignalSummary, LatitudeSignalsListParams } from "../../../services/AdminApi"
import type { TerosClient } from "../../../services/TerosClient"

export type SignalsStatus = "ok" | "unconfigured" | "unauthorized" | "unreachable"

export interface UseLatitudeSignalsResult {
  status: SignalsStatus | null
  signals: LatitudeSignalSummary[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  reload: () => void
  loadMore: () => void
}

export function useLatitudeSignals(
  client: TerosClient,
  params: LatitudeSignalsListParams,
): UseLatitudeSignalsResult {
  const [status, setStatus] = useState<SignalsStatus | null>(null)
  const [signals, setSignals] = useState<LatitudeSignalSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const fetchPage = useCallback(
    async (append: boolean, nextCursor: string | null) => {
      if (append) setLoadingMore(true)
      else setLoading(true)
      setError(null)
      try {
        const res = await client.admin.latitudeSignalsList({
          ...params,
          cursor: append ? nextCursor : undefined,
        })
        setStatus(res.status)
        setSignals((prev) => (append ? [...prev, ...res.signals] : res.signals))
        setCursor(res.nextCursor)
        setHasMore(res.hasMore)
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code
        setError(
          code === "FORBIDDEN"
            ? "Admin privileges required"
            : ((err as { message?: string })?.message ?? "Failed to load signals"),
        )
      } finally {
        if (append) setLoadingMore(false)
        else setLoading(false)
      }
    },
    [client, params],
  )

  const reload = useCallback(() => fetchPage(false, null), [fetchPage])
  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore && cursor) fetchPage(true, cursor)
  }, [fetchPage, loadingMore, hasMore, cursor])

  useEffect(() => {
    if (client.isConnected()) {
      fetchPage(false, null)
      return
    }
    const onConnected = () => {
      fetchPage(false, null)
      client.off("connected", onConnected)
    }
    client.on("connected", onConnected)
    return () => {
      client.off("connected", onConnected)
    }
  }, [client, fetchPage])

  return { status, signals, loading, loadingMore, error, hasMore, reload, loadMore }
}
