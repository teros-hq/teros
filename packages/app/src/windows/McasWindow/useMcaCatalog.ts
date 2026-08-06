/**
 * Loads the read-only MCA catalog + the persisted per-tool health baseline (D-08) once the client
 * is connected. Returns the raw data + loading/error flags; all derivation (join, overall, health
 * bar) stays in the dashboard render so this hook holds no display logic.
 */
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { McaData, McaHealthRecord } from "../../services/AppApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { toolKey } from "./mcaHealth.utils"

type TerosClient = ReturnType<typeof getTerosClient>
type Translate = (key: string, opts?: Record<string, unknown>) => string

interface CatalogSetters {
  setMcas: (v: McaData[]) => void
  setPersistedHealth: (v: Map<string, McaHealthRecord>) => void
  setLoading: (v: boolean) => void
  setError: (v: string) => void
}

/**
 * Fetch the catalog + persisted health in one shot. The catalog is required (a failure rejects and
 * surfaces the error state); persisted health is best-effort — a failure yields an empty array so
 * every catalog tool renders `pending` (no seed fallback remains).
 */
async function fetchCatalog(
  client: TerosClient,
): Promise<{ mcas: McaData[]; health: McaHealthRecord[] }> {
  const mcas = (await client.app.listAllMcas()).mcas
  let health: McaHealthRecord[] = []
  try {
    health = (await client.app.getMcaHealth()).health
  } catch {
    // Persisted health unavailable — every MCA renders `pending` (non-fatal).
  }
  return { mcas, health }
}

/**
 * Run one load into state, guarding every post-await write against `isCancelled` so a load that
 * finishes after unmount/re-run can't touch a stale component. Extracted from the effect so the
 * effect body stays trivial (cognitive complexity, CLAUDE.md).
 */
async function loadInto(
  client: TerosClient,
  isCancelled: () => boolean,
  s: CatalogSetters,
  t: Translate,
): Promise<void> {
  s.setLoading(true)
  try {
    const { mcas, health } = await fetchCatalog(client)
    if (isCancelled()) return
    s.setMcas(mcas)
    s.setPersistedHealth(new Map(health.map((h) => [toolKey(h.mcaId, h.tool), h])))
  } catch (err) {
    if (isCancelled()) return
    s.setError(err instanceof Error ? err.message : t("errors.mcas.loadFailed"))
  } finally {
    if (!isCancelled()) s.setLoading(false)
  }
}

/**
 * Load now if connected, else once on the next `connected` event. Returns a cleanup that detaches
 * the one-shot listener (a no-op when already connected).
 */
function subscribeAndLoad(
  client: TerosClient,
  isCancelled: () => boolean,
  s: CatalogSetters,
  t: Translate,
): () => void {
  const load = () => {
    void loadInto(client, isCancelled, s, t)
  }
  if (client.isConnected()) {
    load()
    return () => {}
  }
  const onConnected = () => {
    load()
    client.off("connected", onConnected)
  }
  client.on("connected", onConnected)
  return () => client.off("connected", onConnected)
}

export function useMcaCatalog(): {
  mcas: McaData[]
  persistedHealth: Map<string, McaHealthRecord>
  loading: boolean
  error: string | null
} {
  const { t } = useTranslation()
  const client = getTerosClient()
  const [mcas, setMcas] = useState<McaData[]>([])
  const [persistedHealth, setPersistedHealth] = useState<Map<string, McaHealthRecord>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `t` intentionally omitted — including it refetches the whole catalog on every language switch (it is only read for a fallback error string, where slight locale staleness is acceptable).
  useEffect(() => {
    let cancelled = false
    const detach = subscribeAndLoad(
      client,
      () => cancelled,
      { setMcas, setPersistedHealth, setLoading, setError },
      t,
    )
    return () => {
      cancelled = true
      detach()
    }
  }, [client])

  return { mcas, persistedHealth, loading, error }
}
