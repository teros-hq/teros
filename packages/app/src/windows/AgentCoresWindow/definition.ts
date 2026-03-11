/**
 * Agent Cores Window Type Definition
 *
 * Admin window to view and manage agent cores (base personalities/engines).
 */

import { Cpu } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { AgentCoresWindowContent } from './AgentCoresWindowContent';

export type AgentCoresWindowProps = {};

export const agentCoresWindowDefinition: WindowTypeDefinition<AgentCoresWindowProps> = {
  type: 'agent-cores',
  displayName: 'Agent Cores',
  icon: Cpu,
  color: '#4A9E5B',
  component: AgentCoresWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  singleton: true,

  getTitle: () => 'Agent Cores',
  getSubtitle: () => 'Base personalities and engines',

  serialize: () => ({}),
  deserialize: () => ({}),
};
