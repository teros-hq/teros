import i18n from "../../i18n"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const PendingApprovalsWindowContent = lazyWithRetry(() =>
  import("./PendingApprovalsWindowContent").then((m) => ({
    default: m.PendingApprovalsWindowContent,
  })),
)

export interface PendingApprovalsWindowProps {
  // No props needed for now
}

export const pendingApprovalsWindowDefinition: WindowTypeDefinition<PendingApprovalsWindowProps> = {
  type: "pending-approvals",
  audience: "user",
  displayName: i18n.t("windows.pendingApprovals"),
  getTitle: () => i18n.t("windows.pendingApprovals"),
  component: PendingApprovalsWindowContent,
  defaultProps: {},
  icon: "🔔" as any,
  phIcon: "shield-check",
  color: "#F59E0B",
  defaultSize: { width: 600, height: 500 },
} as any
