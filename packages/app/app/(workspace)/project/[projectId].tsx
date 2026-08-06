/**
 * Project Route - /project/[projectId]
 *
 * Opens/focuses the project dashboard window for a specific project.
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function ProjectRoute() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'project',
    { projectId },
    (props) => props.projectId === projectId,
    isReady && !!projectId,
  );

  return null;
}
