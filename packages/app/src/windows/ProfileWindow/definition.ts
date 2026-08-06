/**
 * Profile Window Type Definition
 *
 * User profile window with personal information and settings.
 */

import { User } from '@tamagui/lucide-icons';
import i18n from "../../i18n";
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ProfileWindowContent } from './ProfileWindowContent';

export interface ProfileWindowProps {
  /** Callback to log out */
  onLogout?: () => void;
  /** Initial section to open on. Defaults to 'view'. 'plan' opens Plan & billing
   *  directly — used by the hours-exhausted CTA in the chat. */
  initialMode?: 'view' | 'edit' | 'plan';
}

export const profileWindowDefinition: WindowTypeDefinition<ProfileWindowProps> = {
  type: 'profile',
  displayName: 'Profile',
  icon: User,
  color: '#C75450',
  component: ProfileWindowContent,

  defaultSize: { width: 480, height: 600 },
  minSize: { width: 360, height: 400 },


  getTitle: () => i18n.t("profile.title"),

  serialize: () => ({}),
  deserialize: () => ({}),
};
