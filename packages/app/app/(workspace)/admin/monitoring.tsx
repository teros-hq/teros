/**
 * Monitoring deep-link — /admin/monitoring  (A5.5 / TER-672).
 *
 * Shareable URL that opens (or focuses) the Monitoring Hub. An optional
 * `?period=` query pre-selects the period so a link can point at "the 7d view".
 */

import { useLocalSearchParams } from "expo-router"
import { useWindowLauncher } from "../../../src/hooks"
import { useWorkspaceReady } from "../workspaceContext"

export default function MonitoringRoute() {
  const { period } = useLocalSearchParams<{ period?: string }>()
  const isReady = useWorkspaceReady()

  useWindowLauncher(
    "monitoring",
    period ? { initialPeriod: period } : {},
    // Only one Monitoring Hub — focus it whatever its current period.
    () => true,
    isReady,
  )

  return null
}
