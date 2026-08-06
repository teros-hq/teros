/**
 * Billing Audit deep-link — /admin/billing-audit/[userId]
 *
 * Shareable URL that opens (or focuses) the Billing Audit window for a
 * specific user. Falls back to /admin/billing-audit (list) when no userId.
 */

import { useLocalSearchParams } from "expo-router";
import { useWindowLauncher } from "../../../../src/hooks";
import { useWorkspaceReady } from "../../workspaceContext";

export default function BillingAuditRoute() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "billing-audit",
    userId ? { userId } : {},
    (props) => (userId ? props.userId === userId : true),
    isReady && !!userId,
  );

  return null;
}
