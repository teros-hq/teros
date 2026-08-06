/**
 * Billing Audit list deep-link — /admin/billing-audit
 *
 * Opens the Billing Audit window without a pre-selected user.
 */

import { useWindowLauncher } from "../../../../src/hooks";
import { useWorkspaceReady } from "../../workspaceContext";

export default function BillingAuditListRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "billing-audit",
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
