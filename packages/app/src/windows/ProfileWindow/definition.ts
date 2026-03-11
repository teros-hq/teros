/**
 * Profile Window Type Definition
 *
 * User profile window with personal information and settings.
 */

import { User } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ProfileWindowContent } from './ProfileWindowContent';

export interface ProfileWindowProps {
  /** Callback to log out */
  onLogout?: () => void;
}

export const profileWindowDefinition: WindowTypeDefinition<ProfileWindowProps> = {
  type: 'profile',
  displayName: 'Profile',
  icon: User,
  color: '#C75450',
  component: ProfileWindowContent,

  defaultSize: { width: 480, height: 600 },
  minSize: { width: 360, height: 400 },

  singleton: true,

  getTitle: () => 'Mi Perfil',

  serialize: () => ({}),
  deserialize: () => ({}),
};
