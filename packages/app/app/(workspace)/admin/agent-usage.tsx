/**
 * Agent Activity deep-link — /admin/agent-usage
 *
 * Shareable URL that opens (or focuses) the Agent Activity window.
 */

import { useWindowLauncher } from "../../../src/hooks";
import { useWorkspaceReady } from "../workspaceContext";

export default function AgentUsageRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "agent-usage",
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
