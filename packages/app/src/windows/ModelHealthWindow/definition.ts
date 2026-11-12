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
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { ModelHealthWindowProps } from "./ModelHealthWindowContent"
const ModelHealthWindowContent = lazyWithRetry(() =>
  import("./ModelHealthWindowContent").then((m) => ({ default: m.ModelHealthWindowContent })),
)

// Re-export the component's real prop type (now carries the optional deep-link period).
export type { ModelHealthWindowProps }

export const modelHealthWindowDefinition: WindowTypeDefinition<ModelHealthWindowProps> = {
  type: "model-health",
  audience: "admin",
  displayName: "Model Health",
  icon: Gauge,
  phIcon: "heartbeat",
  color: "#6F27FF",
  component: ModelHealthWindowContent,

  defaultSize: { width: 1100, height: 760 },
  minSize: { width: 720, height: 480 },

  getTitle: () => "Model Health",
  getSubtitle: () => "Provider latency, errors & throughput",

  serialize: () => ({}),
  deserialize: () => ({}),
}
