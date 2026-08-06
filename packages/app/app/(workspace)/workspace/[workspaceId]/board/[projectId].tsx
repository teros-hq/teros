/**
 * Legacy Board Route - /workspace/[workspaceId]/board/[projectId]
 *
 * Redirects to the canonical /board/[projectId] route.
 * The workspaceId segment is ignored — workspace context is inferred from the session.
 */

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function LegacyBoardRoute() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  return <Redirect href={`/board/${projectId}`} />;
}
