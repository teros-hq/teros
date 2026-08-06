/**
 * Archived Conversations Window Type Definition
 *
 * Dedicated window for browsing and restoring archived conversations.
 */

import { Archive } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ArchivedConversationsWindowContent } from './ArchivedConversationsWindowContent';
import i18n from '../../i18n';

export interface ArchivedConversationsWindowProps {
  /** Workspace context */
  workspaceId?: string;
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


    getTitle: () => i18n.t("windows.archivedConversations"),

    serialize: (props) => ({ workspaceId: props.workspaceId, searchQuery: props.searchQuery }),
    deserialize: (data) => ({ workspaceId: data.workspaceId, searchQuery: data.searchQuery }),
  };
