/**
 * Archived Conversations Window Type Definition
 *
 * Dedicated window for browsing and restoring archived conversations.
 */

import { Archive } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ArchivedConversationsWindowContent } from './ArchivedConversationsWindowContent';

export interface ArchivedConversationsWindowProps {
  /** Optional search query to pre-fill */
  searchQuery?: string;
}

export const archivedConversationsWindowDefinition: WindowTypeDefinition<ArchivedConversationsWindowProps> =
  {
    type: 'archived-conversations',
    displayName: 'Archivadas',
    icon: Archive,
    color: '#4A9BA8',
    component: ArchivedConversationsWindowContent,

    defaultSize: { width: 320, height: 450 },
    minSize: { width: 250, height: 300 },

    singleton: true,

    getTitle: () => 'Archivadas',

    serialize: (props) => ({ searchQuery: props.searchQuery }),
    deserialize: (data) => ({ searchQuery: data.searchQuery }),
  };
