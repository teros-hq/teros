/**
 * Users Window Type Definition
 *
 * Admin window to view and manage users.
 */

import { Users } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { UsersWindowContent } from './UsersWindowContent';

export type UsersWindowProps = {};

export const usersWindowDefinition: WindowTypeDefinition<UsersWindowProps> = {
  type: 'users',
  displayName: 'Users',
  icon: Users,
  color: '#C75450',
  component: UsersWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  singleton: true,

  getTitle: () => 'Users',
  getSubtitle: () => 'User management',

  serialize: () => ({}),
  deserialize: () => ({}),
};
