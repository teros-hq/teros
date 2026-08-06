/**
 * Monitoring Hub Window Definition — the single admin entry point for
 * observability. Drills into Usage & Costs, Agent Activity, Model Health and
 * Session Trace (which lost their individual Navbar entries). Admin-only via the
 * server-side `requireSystemAdmin` on the actions it reads.
 */

import { LayoutDashboard } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { MonitoringWindowContent, type MonitoringWindowProps } from "./MonitoringWindowContent"

export const monitoringWindowDefinition: WindowTypeDefinition<MonitoringWindowProps> = {
  type: "monitoring",
  displayName: "Monitoring",
  icon: LayoutDashboard,
  color: "#5E6AD2",
  component: MonitoringWindowContent,

  defaultSize: { width: 1200, height: 820 },
  minSize: { width: 720, height: 480 },

  getTitle: () => "Monitoring",
  getSubtitle: () => "Unified observability hub",

  serialize: () => ({}),
  deserialize: () => ({}),
}
