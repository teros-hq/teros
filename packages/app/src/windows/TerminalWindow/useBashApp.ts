/**
 * useBashApp — resolves the appId of the bash MCA for a given workspace
 *
 * Uses mca.teros.bash (Docker container). Returns { appId, mcaId, status,
 * loading, reload } — appId is null if not found or still loading.
 *
 * (Until 2026-10-19 this preferred mca.teros.admin.bash for host access;
 * the admin MCAs were retired in favor of Teros Remote — task_674f6a80d7618a49.)
 */

import { useCallback, useEffect, useState } from "react"
import { getTerosClient } from "../../services/terosClientSingleton"

const PREFERRED_MCAS = ["mca.teros.bash"] as const

export function useBashApp(workspaceId?: string): {
  appId: string | null
  mcaId: string | null
  status: string | null
  loading: boolean
  reload: () => void
} {
  const [appId, setAppId] = useState<string | null>(null)
  const [mcaId, setMcaId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const client = getTerosClient()

  useEffect(() => {
    void nonce
    if (!workspaceId || !client) {
      setLoading(false)
      return
    }

    setLoading(true)
    client
      .listWorkspaceApps(workspaceId)
      .then((apps) => {
        for (const preferred of PREFERRED_MCAS) {
          const found = apps.find((a: any) => a.mcaId === preferred)
          if (found) {
            setAppId(found.appId)
            setMcaId(found.mcaId)
            setStatus((found as any).status ?? null)
            return
          }
        }
        setAppId(null)
        setMcaId(null)
        setStatus(null)
      })
      .catch(() => {
        setAppId(null)
        setMcaId(null)
        setStatus(null)
      })
      .finally(() => setLoading(false))
  }, [workspaceId, client, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { appId, mcaId, status, loading, reload }
}
