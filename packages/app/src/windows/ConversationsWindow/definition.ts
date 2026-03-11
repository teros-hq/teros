/**
 * Conversations Window Type Definition
 *
 * Lista de conversaciones con agentes, similar al sidebar pero como ventana movible.
 */

import { MessageCircle } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ConversationsWindowContent } from './ConversationsWindowContent';

export interface ConversationsWindowProps {
  /** Filtro inicial: 'active' | 'inactive' | 'archived' | 'all' */
  filter?: 'active' | 'inactive' | 'archived' | 'all';
}

export const conversationsWindowDefinition: WindowTypeDefinition<ConversationsWindowProps> = {
  type: 'conversations',
  displayName: 'Conversaciones',
  icon: MessageCircle,
  color: '#4A9BA8',
  component: ConversationsWindowContent,

  defaultSize: { width: 280, height: 500 },
  minSize: { width: 200, height: 300 },

  singleton: true,
  isLauncher: true,

  getTitle: (props) => {
    switch (props.filter) {
      case 'inactive':
        return 'Inactivas';
      case 'archived':
        return 'Archivadas';
      case 'all':
        return 'Todas';
      default:
        return 'Conversaciones';
    }
  },

  serialize: (props) => ({ filter: props.filter }),
  deserialize: (data) => ({ filter: data.filter || 'active' }),
};
