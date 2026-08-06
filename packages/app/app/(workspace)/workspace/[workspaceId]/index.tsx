/**
 * Workspace Route - /workspace/[workspaceId]
 *
 * Switches to the given workspace and redirects to the root route (/).
 * This allows deep-linking to a specific workspace via URL.
 */

import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { useWorkspaceStore } from '../../../../src/store/workspaceStore';

export default function WorkspaceRoute() {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);

  useEffect(() => {
    if (workspaceId) {
      setActiveWorkspace(workspaceId);
    }
  }, [workspaceId]);

  return <Redirect href="/" />;
}
