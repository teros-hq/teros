import { Building2 } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { BillingTeamsWindowProps } from "./BillingTeamsWindowContent"
const BillingTeamsWindowContent = lazyWithRetry(() =>
  import("./BillingTeamsWindowContent").then((m) => ({ default: m.BillingTeamsWindowContent })),
)

// No persistable props — the window opens on the team list and drills into a
// team via internal state (same as billing-requests).
export const billingTeamsWindowDefinition: WindowTypeDefinition<BillingTeamsWindowProps> = {
  type: "billing-teams",
  audience: "admin",
  displayName: i18n.t("windows.billingTeams"),
  getTitle: () => i18n.t("windows.billingTeams"),
  component: BillingTeamsWindowContent,
  defaultProps: {},
  icon: Building2 as any,
  phIcon: "users-three",
  color: "#6F27FF",
  defaultSize: { width: 780, height: 640 },
  minSize: { width: 520, height: 400 },
} as any
