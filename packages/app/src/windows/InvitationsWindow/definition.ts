/**
 * Invitations Window Type Definition
 *
 * Window for managing the invitation system in Teros.
 */

import { UserPlus } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { InvitationsWindowContent } from './InvitationsWindowContent';

export type InvitationsTab = 'status' | 'send' | 'sent';

export interface InvitationsWindowProps {
  tab?: InvitationsTab;
}

export const invitationsWindowDefinition: WindowTypeDefinition<InvitationsWindowProps> = {
  type: 'invitations',
  displayName: 'Invitations',
  icon: UserPlus,
  color: '#C75450',
  component: InvitationsWindowContent,

  defaultSize: { width: 700, height: 600 },
  minSize: { width: 400, height: 400 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'Invitaciones',
  getSubtitle: (props) => {
    switch (props.tab) {
      case 'send':
        return 'Send invitation';
      case 'sent':
        return 'Invitaciones enviadas';
      default:
        return 'Estado de invitaciones';
    }
  },

  serialize: (props) => ({ tab: props.tab }),
  deserialize: (data) => ({ tab: data.tab as InvitationsTab | undefined }),
};
