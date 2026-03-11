/**
 * Workspaces List Window Type Definition
 *
 * User workspaces list with the option to create new ones.
 * Opened from the "Projects" button in the Navbar.
 */

import { Folder } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { WorkspacesListWindowContent } from './WorkspacesListWindowContent';

export interface WorkspacesListWindowProps {
  /** Initial status filter */
  status?: 'active' | 'archived';
  /** Initial search query */
  search?: string;
}

export const workspacesListWindowDefinition: WindowTypeDefinition<WorkspacesListWindowProps> = {
  type: 'workspaces',
  displayName: 'Workspaces',
  icon: Folder,
  color: '#C4923B',
  component: WorkspacesListWindowContent,

  defaultSize: { width: 700, height: 500 },
  minSize: { width: 400, height: 300 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'Workspaces',

  serialize: (props) => ({
    status: props.status,
    search: props.search,
  }),
  deserialize: (data) => ({
    status: data.status,
    search: data.search,
  }),
};
