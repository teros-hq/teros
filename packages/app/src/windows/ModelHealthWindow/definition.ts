/**
 * Model Health Window Definition (TER-616 / F1).
 *
 * Admin window for proactive degradation detection of LLM providers: per-
 * `actualProvider×modelId` latency/TTFT percentiles, error-rate by kind and
 * throughput. Complements `AgentUsageWindow` (activity/quota) and `UsageWindow`
 * (cost) — this one is reliability-centric.
 *
 * Backend action consumed: admin-api.agent-usage-model-health
 * Auth: requireSystemAdmin enforced server-side (users.role ∈ admin|super).
 */

import { Gauge } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { ModelHealthWindowContent, type ModelHealthWindowProps } from "./ModelHealthWindowContent"

// Re-export the component's real prop type (now carries the optional deep-link period).
export type { ModelHealthWindowProps }

export const modelHealthWindowDefinition: WindowTypeDefinition<ModelHealthWindowProps> = {
  type: "model-health",
  displayName: "Model Health",
  icon: Gauge,
  color: "#F59E0B",
  component: ModelHealthWindowContent,

  defaultSize: { width: 1100, height: 760 },
  minSize: { width: 720, height: 480 },

  getTitle: () => "Model Health",
  getSubtitle: () => "Provider latency, errors & throughput",

  serialize: () => ({}),
  deserialize: () => ({}),
}
