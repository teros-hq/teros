/**
 * Pending Approvals Route - /pending-approvals
 *
 * Opens/focuses the pending approvals window.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function PendingApprovalsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'pending-approvals',
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
