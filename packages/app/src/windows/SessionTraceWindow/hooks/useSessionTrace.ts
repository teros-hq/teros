/**
 * `useSessionTrace()` — fetch lifecycle for one turn's drill-down (F2 /
 * TER-643). Loads `admin-api.agent-usage-session-detail` for the given
 * sessionUsageId (null = idle, nothing requested). Distinguishes NOT_FOUND (the
 * id doesn't exist → dedicated empty state) from FORBIDDEN and generic errors,
 * mirroring `useModelHealthData`'s connection handling.
 */

import { useCallback, useEffect, useState } from "react"
import type { SessionTrace } from "../../../services/AdminApi"
import type { TerosClient } from "../../../services/TerosClient"

export interface UseSessionTraceResult {
  trace: SessionTrace | null
  loading: boolean
  error: string | null
  notFound: boolean
  reload: () => void
}

export function useSessionTrace(
  client: TerosClient,
  sessionUsageId: string | null,
): UseSessionTraceResult {
  const [trace, setTrace] = useState<SessionTrace | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const load = useCallback(async () => {
    if (!sessionUsageId) {
      setTrace(null)
      setError(null)
      setNotFound(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const res = await client.admin.agentUsageSessionDetail(sessionUsageId)
      setTrace(res)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === "NOT_FOUND") {
        setNotFound(true)
        setTrace(null)
      } else if (code === "FORBIDDEN") {
        setError("Admin privileges required")
      } else {
        setError((err as { message?: string })?.message ?? "Failed to load trace")
      }
    } finally {
      setLoading(false)
    }
  }, [client, sessionUsageId])

  useEffect(() => {
    if (!sessionUsageId) return
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
  }, [client, sessionUsageId, load])

  return { trace, loading, error, notFound, reload: load }
}
