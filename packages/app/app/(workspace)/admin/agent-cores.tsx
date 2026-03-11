/**
 * Agent Cores Route - /admin/agent-cores
 *
 * Abre/enfoca la ventana de configuración de agent cores.
 */

import { useWindowLauncher } from '../../../src/hooks';
import { useWorkspaceReady } from '../workspaceContext';

export default function AgentCoresRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'agent-cores',
    {},
    () => true, // Solo puede haber una ventana de agent cores
    isReady,
  );

  return null;
}
