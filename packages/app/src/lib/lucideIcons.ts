/**
 * The full Lucide icon set, loaded on demand.
 *
 * Only the icon pickers (which list every Lucide name) and the Lucide fallback
 * of WorkspaceIcon need the namespace. A static `import * as` put all ~1.4 MB of
 * it in the entry bundle for everyone; this loads it as its own chunk the first
 * time something asks for it.
 *
 * @spec LOADP-REQ-1
 */
import { useEffect, useState } from "react"

export type LucideNamespace = Record<string, any>

let loaded: LucideNamespace | null = null
let pending: Promise<LucideNamespace> | null = null

export function loadLucideIcons(): Promise<LucideNamespace> {
  if (loaded) return Promise.resolve(loaded)
  pending ??= import("@tamagui/lucide-icons").then((m) => {
    loaded = m as unknown as LucideNamespace
    return loaded
  })
  return pending
}

/** The Lucide namespace, or null until it has loaded (and while `enabled` is false). */
export function useLucideIcons(enabled = true): LucideNamespace | null {
  const [ns, setNs] = useState<LucideNamespace | null>(loaded)
  useEffect(() => {
    if (!enabled || ns) return
    let alive = true
    loadLucideIcons().then((m) => alive && setNs(m))
    return () => {
      alive = false
    }
  }, [enabled, ns])
  return ns
}
