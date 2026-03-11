/**
 * Board Window Type Definition
 *
 * Kanban board for project task management.
 * Shows columns with draggable task cards.
 */

import { SquareKanban } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { BoardWindowContent } from './BoardWindowContent';

export interface BoardWindowProps {
  /** Workspace to show projects from */
  workspaceId?: string;
  /** Pre-selected project */
  projectId?: string;
  /** Name of the selected project (used for tab title) */
  projectName?: string;
}

export const boardWindowDefinition: WindowTypeDefinition<BoardWindowProps> = {
  type: 'board',
  displayName: 'Board',
  icon: SquareKanban,
  color: '#8B5CF6', // Purple

  component: BoardWindowContent,

  defaultSize: { width: 900, height: 600 },
  minSize: { width: 600, height: 400 },

  singleton: false,
  isLauncher: true,

  getTitle: (props) => props.projectName || 'Board',

  getKey: (props) => props.projectId || undefined,

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    projectId: props.projectId,
    projectName: props.projectName,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    projectId: data.projectId,
    projectName: data.projectName,
  }),
};
