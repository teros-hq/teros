/**
 * Billing Teams deep-link — /admin/billing-teams
 *
 * Shareable URL that opens (or focuses) the Billing Teams window.
 */

import { useWindowLauncher } from "../../../src/hooks";
import { useWorkspaceReady } from "../workspaceContext";

export default function BillingTeamsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "billing-teams",
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
