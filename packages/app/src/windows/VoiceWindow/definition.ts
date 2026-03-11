/**
 * Voice Window Type Definition
 * 
 * Define el tipo de ventana para conversaciones de voz con agentes.
 */

import { Mic } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { VoiceWindowContent } from './VoiceWindowContent';

// ============================================
// PROPS
// ============================================

export interface VoiceWindowProps {
  /** Agent ID - required to start voice conversation */
  agentId: string;
  /** Agent name - for display in title */
  agentName?: string;
  /** Channel ID - if connecting to existing conversation */
  channelId?: string;
}

// ============================================
// DEFINITION
// ============================================

export const voiceWindowDefinition: WindowTypeDefinition<VoiceWindowProps> = {
  type: 'voice',
  displayName: 'Voice Chat',
  icon: Mic,
  color: '#8B5CF6', // Purple
  component: VoiceWindowContent,

  defaultSize: { width: 400, height: 650 },
  minSize: { width: 350, height: 500 },

  // Deduplicate by agentId (only one voice conversation per agent)
  getKey: (props) => props.agentId,

  getTitle: (props) => {
    if (props.agentName) {
      return `Voice: ${props.agentName}`;
    }
    return 'Voice Chat';
  },

  getSubtitle: (props) => {
    return 'Real-time conversation';
  },

  serialize: (props) => ({
    agentId: props.agentId,
    agentName: props.agentName,
    channelId: props.channelId,
  }),

  deserialize: (data) => ({
    agentId: data.agentId as string,
    agentName: data.agentName as string | undefined,
    channelId: data.channelId as string | undefined,
  }),

  onFocus: (windowId, props) => {
    // Could clear notifications here
  },
};
