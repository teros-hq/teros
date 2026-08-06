/**
 * Skills Route - /skills
 *
 * Opens/focuses the skills window.
 */

import { useWindowLauncher } from '../../src/hooks';
import { useWorkspaceReady } from './workspaceContext';

export default function SkillsRoute() {
  const isReady = useWorkspaceReady();

  useWindowLauncher(
    'skills',
    {},
    () => true, // Singleton
    isReady,
  );

  return null;
}
