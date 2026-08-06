/**
 * Terminal Route - /terminal
 *
 * Opens/focuses a terminal window.
 * Query params: ?cwd=<initialCwd>&workspaceId=<id>
 */

import { useLocalSearchParams } from 'expo-router';
import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function TerminalRoute() {
  const { cwd, workspaceId } = useLocalSearchParams<{
    cwd?: string;
    workspaceId?: string;
  }>();
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'terminal',
    { initialCwd: cwd, workspaceId },
    // Focus the default terminal if no sessionId-specific match
    (props) => (cwd ? props.initialCwd === cwd : true),
    isReady,
  );

  return null;
}
