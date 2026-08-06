/**
 * Billing Requests deep-link — /admin/billing-requests
 *
 * Shareable URL that opens (or focuses) the Billing Requests window.
 */

import { useWindowLauncher } from "../../../src/hooks";
import { useWorkspaceReady } from "../workspaceContext";

export default function BillingRequestsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "billing-requests",
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
