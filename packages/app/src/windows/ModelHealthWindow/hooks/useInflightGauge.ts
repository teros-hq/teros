/**
 * `useInflightGauge()` — polling lifecycle for the live in-flight LLM-stream
 * gauge (F1.3). Unlike the rollup-backed model-health data, in-flight is a
 * real-time, ephemeral signal, so it has its OWN cadence: poll every few
 * seconds rather than only on refresh. Best-effort — a failed poll surfaces an
 * inline error but never blanks the gauge or the surrounding dashboard.
 */

import { useCallback, useEffect, useState } from "react"
import type { TerosClient } from "../../../services/TerosClient"

const POLL_MS = 5000

export interface UseInflightGaugeResult {
  inflight: Record<string, number>
  total: number
  capturedAt: string | null
  error: string | null
}

export function useInflightGauge(client: TerosClient): UseInflightGaugeResult {
  const [inflight, setInflight] = useState<Record<string, number>>({})
  const [total, setTotal] = useState(0)
  const [capturedAt, setCapturedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await client.admin.agentUsageInflight()
      setInflight(res.inflight)
      setTotal(res.total)
      setCapturedAt(res.capturedAt)
      setError(null)
    } catch (err: unknown) {
      setError((err as { message?: string })?.message ?? "Failed to read in-flight")
    }
  }, [client])

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false
    const start = () => {
      if (cancelled) return
      poll()
      timer = setInterval(poll, POLL_MS)
    }
    const onConnected = () => {
      client.off("connected", onConnected)
      start()
    }
    if (client.isConnected()) start()
    else client.on("connected", onConnected)
    return () => {
      cancelled = true
      client.off("connected", onConnected)
      if (timer) clearInterval(timer)
    }
  }, [client, poll])

  return { inflight, total, capturedAt, error }
}
