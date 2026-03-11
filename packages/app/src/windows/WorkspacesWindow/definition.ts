/**
 * Workspace Window Type Definition (singular)
 *
 * Detail view of a specific workspace.
 * Muestra el volumen, apps instaladas y miembros.
 */

import { Folder } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { WorkspaceWindowContent } from './WorkspaceWindowContent';

export interface WorkspaceWindowProps {
  /** ID del workspace a mostrar */
  workspaceId: string;
}

export const workspaceWindowDefinition: WindowTypeDefinition<WorkspaceWindowProps> = {
  type: 'workspace',
  displayName: 'Workspace',
  icon: Folder,
  color: '#C4923B',
  component: WorkspaceWindowContent,

  defaultSize: { width: 800, height: 600 },
  minSize: { width: 500, height: 400 },

  getKey: (props) => props.workspaceId,

  getTitle: (props) => 'Workspace',

  serialize: (props) => ({
    workspaceId: props.workspaceId,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
  }),
};
