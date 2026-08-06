/**
 * Agent Cores Window Type Definition
 *
 * Admin window to view and manage agent cores (base personalities/engines).
 */

import { Cpu } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { AgentCoresWindowContent } from './AgentCoresWindowContent';
import i18n from '../../i18n';

export type AgentCoresWindowProps = {};

export const agentCoresWindowDefinition: WindowTypeDefinition<AgentCoresWindowProps> = {
  type: 'agent-cores',
  displayName: 'Agent Cores',
  icon: Cpu,
  color: '#4A9E5B',
  component: AgentCoresWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },


  getTitle: () => i18n.t("windows.agentCores"),
  getSubtitle: () => i18n.t("windows.agentCoresSub"),

  serialize: () => ({}),
  deserialize: () => ({}),
};
