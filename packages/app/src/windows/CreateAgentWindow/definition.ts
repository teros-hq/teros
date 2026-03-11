/**
 * Create Agent Window Type Definition
 *
 * Shows role templates for creating a new agent.
 * When user selects a role, creates the agent and opens agent config.
 */

import { UserPlus } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { CreateAgentWindowContent } from './CreateAgentWindowContent';

export interface CreateAgentWindowProps {
  workspaceId?: string;
}

export const createAgentWindowDefinition: WindowTypeDefinition<CreateAgentWindowProps> = {
  type: 'create-agent',
  displayName: 'Crear Agente',
  icon: UserPlus,
  color: '#8B5CF6',
  component: CreateAgentWindowContent,

  defaultSize: { width: 600, height: 500 },
  minSize: { width: 400, height: 400 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'Crear Agente',

  serialize: (props) => ({ workspaceId: props.workspaceId }),
  deserialize: (data) => ({ workspaceId: data.workspaceId }),
};
