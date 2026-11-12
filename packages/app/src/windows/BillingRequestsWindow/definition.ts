import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const BillingRequestsWindowContent = lazyWithRetry(() =>
  import("./BillingRequestsWindowContent").then((m) => ({
    default: m.BillingRequestsWindowContent,
  })),
)

export interface BillingRequestsWindowProps {
  // No props needed.
}

export const billingRequestsWindowDefinition: WindowTypeDefinition<BillingRequestsWindowProps> = {
  type: "billing-requests",
  audience: "admin",
  displayName: i18n.t("windows.billingRequests"),
  getTitle: () => i18n.t("windows.billingRequests"),
  component: BillingRequestsWindowContent,
  defaultProps: {},
  icon: "💳" as any,
  phIcon: "credit-card",
  color: "#6F27FF",
  defaultSize: { width: 640, height: 560 },
} as any
