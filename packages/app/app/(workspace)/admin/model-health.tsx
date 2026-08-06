/**
 * Model Health deep-link — /admin/model-health
 *
 * Shareable URL that opens (or focuses) the Model Health window.
 */

import { useWindowLauncher } from "../../../src/hooks";
import { useWorkspaceReady } from "../workspaceContext";

export default function ModelHealthRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "model-health",
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
