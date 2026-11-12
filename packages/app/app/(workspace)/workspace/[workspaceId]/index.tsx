/**
 * Workspace Route — /workspace/[workspaceId] (the session shell URL)
 *
 * The real shell route: the group layout renders the TilingLayout, this route
 * renders null and owns the session-URL semantics via WorkspaceShellInit:
 * - URL workspace ≠ active workspace → switch and STAY (no redirect to "/",
 *   which would loop with the root resolver).
 * - First paint per workspace: open the default conversations window if the
 *   restored layout has no windows.
 *
 * The bare URL (no /desktop/[n] segment) means "the active desktop, whatever
 * it is" — desktop 0 is never forced here.
 */

import { useLocalSearchParams } from 'expo-router';
import { WorkspaceShellInit } from '../../../../src/components/workspace/WorkspaceShellInit';
import { useWorkspaceReady } from '../../workspaceContext';

export default function WorkspaceRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const isReady = useWorkspaceReady();

  if (!workspaceId) return null;
  return <WorkspaceShellInit workspaceId={workspaceId} isReady={isReady} />;
}
