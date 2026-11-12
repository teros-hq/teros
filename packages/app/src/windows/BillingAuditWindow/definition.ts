import { ScrollText } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import type { BillingAuditWindowProps } from "./BillingAuditWindowContent"
const BillingAuditWindowContent = lazyWithRetry(() =>
  import("./BillingAuditWindowContent").then((m) => ({ default: m.BillingAuditWindowContent })),
)

export const billingAuditWindowDefinition: WindowTypeDefinition<BillingAuditWindowProps> = {
  type: "billing-audit",
  audience: "admin",
  displayName: i18n.t("windows.billingAudit"),
  getTitle: () => i18n.t("windows.billingAudit"),
  component: BillingAuditWindowContent,
  defaultProps: {},
  icon: ScrollText as any,
  phIcon: "receipt",
  color: "#6F27FF",
  defaultSize: { width: 720, height: 600 },
  minSize: { width: 480, height: 360 },
  // Persists which user is being audited so the tab restores after reload.
  serialize: (props: BillingAuditWindowProps) => ({
    userId: props.userId,
    subscriptionId: props.subscriptionId,
    userName: props.userName,
  }),
  deserialize: (data: Record<string, any>) => ({
    userId: data.userId,
    subscriptionId: data.subscriptionId,
    userName: data.userName,
  }),
} as any
