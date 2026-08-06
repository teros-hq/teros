/**
 * Latitude Signals Window Definition (F4 · C2).
 *
 * Admin window that browses Latitude's clustered-failure signals inside Teros —
 * the "buy" side of the build-vs-buy split (Latitude does the clustering; Teros
 * shows it). Complements SessionTraceWindow (per-turn) and ModelHealthWindow
 * (aggregate health).
 *
 * Backend action consumed: admin-api.latitude-signals-list
 * Auth: requireSystemAdmin enforced server-side.
 */

import { Zap } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { LatitudeSignalsWindowContent } from "./LatitudeSignalsWindowContent"

export const latitudeSignalsWindowDefinition: WindowTypeDefinition<Record<string, never>> = {
  type: "latitude-signals",
  displayName: "Latitude Signals",
  icon: Zap,
  color: "#F59E0B",
  isLauncher: true,
  adminOnly: true,
  component: LatitudeSignalsWindowContent,

  defaultSize: { width: 900, height: 760 },
  minSize: { width: 560, height: 440 },

  getTitle: () => "Latitude Signals",
  getSubtitle: () => "Clustered failures",

  serialize: () => ({}),
  deserialize: () => ({}),
}
