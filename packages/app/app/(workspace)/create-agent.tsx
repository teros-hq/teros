/**
 * Create Agent Route - /create-agent
 *
 * Opens/focuses the create agent window (role templates).
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function CreateAgentRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'create-agent',
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
