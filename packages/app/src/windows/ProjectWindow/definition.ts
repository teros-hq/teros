/**
 * Project Window Type Definition
 *
 * Dashboard view for a single project — shows stats, active tasks, and context editor.
 */

import { FolderKanban } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ProjectWindowContent } from './ProjectWindowContent';

export interface ProjectWindowProps {
  /** Project ID to display */
  projectId: string;
  /** Project name (used for tab title) */
  projectName?: string;
  /** Workspace ID (optional context) */
  workspaceId?: string;
}

export const projectWindowDefinition: WindowTypeDefinition<ProjectWindowProps> = {
  type: 'project',
  displayName: 'Project',
  icon: FolderKanban,
  color: '#E8A838',

  component: ProjectWindowContent,

  defaultSize: { width: 860, height: 620 },
  minSize: { width: 480, height: 360 },

  isLauncher: false,

  getTitle: (props) => props.projectName ?? i18n.t("windows.project"),

  getKey: (props) => props.projectId,

  serialize: (props) => ({
    projectId: props.projectId,
    projectName: props.projectName,
    workspaceId: props.workspaceId,
  }),
  deserialize: (data) => ({
    projectId: data.projectId,
    projectName: data.projectName,
    workspaceId: data.workspaceId,
  }),
};
