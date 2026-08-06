/**
 * Per-mcaId lazy caches for the health dashboard (D-12): tool schemas + resolvability, filled on the
 * first expand / Retest / Test for that MCA — never swept across all MCAs on window load. Split from
 * the runner so caching is its own cohesive, independently-testable unit.
 */
import { useCallback, useState } from "react"
import type { McaResolvability, McaToolSchema } from "../../services/AppApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { NOT_INSTALLED_REASON } from "./mcaHealth.utils"

export interface McaLazyCaches {
  resolvabilityCache: Map<string, McaResolvability>
  ensureResolvability: (mcaId: string) => Promise<McaResolvability | undefined>
  ensureSchemas: (mcaId: string) => Promise<McaToolSchema[]>
  /** Cache the TYPED not-installed reason (same wire value app.get-mca-resolvability returns) so the
   *  render localizes it — never a raw English error string (REQ-16). Used by the run error path. */
  markNotInstalled: (mcaId: string) => void
}

export function useMcaLazyCaches(): McaLazyCaches {
  const client = getTerosClient()
  const [schemaCache, setSchemaCache] = useState<Map<string, McaToolSchema[]>>(new Map())
  const [resolvabilityCache, setResolvabilityCache] = useState<Map<string, McaResolvability>>(
    new Map(),
  )

  const ensureResolvability = useCallback(
    async (mcaId: string): Promise<McaResolvability | undefined> => {
      const cached = resolvabilityCache.get(mcaId)
      if (cached) return cached
      try {
        const res = await client.app.getMcaResolvability(mcaId)
        setResolvabilityCache((prev) => new Map(prev).set(mcaId, res))
        return res
      } catch {
        // A failed probe must not crash the row; leave it uncached so a later Retest re-probes.
        return undefined
      }
    },
    [client, resolvabilityCache],
  )

  const ensureSchemas = useCallback(
    async (mcaId: string): Promise<McaToolSchema[]> => {
      const cached = schemaCache.get(mcaId)
      if (cached) return cached
      const { tools } = await client.app.getMcaToolSchemas(mcaId)
      setSchemaCache((prev) => new Map(prev).set(mcaId, tools))
      return tools
    },
    [client, schemaCache],
  )

  const markNotInstalled = useCallback((mcaId: string) => {
    setResolvabilityCache((prev) =>
      new Map(prev).set(mcaId, { runnable: false, reason: NOT_INSTALLED_REASON }),
    )
  }, [])

  return { resolvabilityCache, ensureResolvability, ensureSchemas, markNotInstalled }
}
