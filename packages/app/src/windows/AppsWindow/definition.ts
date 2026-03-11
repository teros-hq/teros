/**
 * Apps Window Type Definition
 *
 * List of installed applications and catalog to install new ones.
 */

import { Package } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { AppsWindowContent } from './AppsWindowContent';

export interface AppsWindowProps {
  /** Initial search query */
  search?: string;
}

export const appsWindowDefinition: WindowTypeDefinition<AppsWindowProps> = {
  type: 'apps',
  displayName: 'Mis Apps',
  icon: Package,
  color: '#7A54A6',
  component: AppsWindowContent,

  defaultSize: { width: 800, height: 600 },
  minSize: { width: 400, height: 300 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'Mis Apps',

  serialize: (props) => ({
    search: props.search,
  }),
  deserialize: (data) => ({
    search: data.search,
  }),
};
