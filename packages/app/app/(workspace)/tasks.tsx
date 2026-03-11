/**
 * Tasks Route - /tasks
 *
 * Abre/enfoca la ventana de tareas.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function TasksRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'tasks',
    {},
    () => true, // Solo puede haber una ventana de tareas
    isReady,
  );

  return null;
}
