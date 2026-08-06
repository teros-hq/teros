/**
 * Feature Flags deep-link — /admin/feature-flags
 *
 * Shareable URL that opens (or focuses) the Feature Flags window.
 * An optional `?search=` query pre-filters the list.
 */

import { useLocalSearchParams } from "expo-router";
import { useWindowLauncher } from "../../../src/hooks";
import { useWorkspaceReady } from "../workspaceContext";

export default function FeatureFlagsRoute() {
  const { search } = useLocalSearchParams<{ search?: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    "feature-flags",
    search ? { search } : {},
    () => true, // Singleton — focus whatever search state it has
    isReady,
  );

  return null;
}
