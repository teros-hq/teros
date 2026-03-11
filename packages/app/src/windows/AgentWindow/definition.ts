/**
 * Agent Window Type Definition
 *
 * Agent configuration: permissions, apps, avatar, etc.
 */

import { Bot } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { AgentWindowContent } from './AgentWindowContent';

export interface AgentWindowProps {
  agentId: string;
  workspaceId?: string;
}

export const agentWindowDefinition: WindowTypeDefinition<AgentWindowProps> = {
  type: 'agent',
  displayName: 'Agente',
  icon: Bot,
  color: '#4A9E5B',
  component: AgentWindowContent,

  defaultSize: { width: 600, height: 500 },
  minSize: { width: 400, height: 300 },

  getKey: (props) => props.agentId,

  getTitle: () => 'Configurar Agente',
  getSubtitle: (props) => props.agentId,

  serialize: (props) => ({ agentId: props.agentId, workspaceId: props.workspaceId }),
  deserialize: (data) => ({ agentId: data.agentId, workspaceId: data.workspaceId }),
};
