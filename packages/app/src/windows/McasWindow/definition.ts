/**
 * MCAs Window Type Definition
 *
 * Admin window to view and manage the MCA catalog.
 */

import { Package } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { McasWindowContent } from './McasWindowContent';

export type McasWindowProps = {};

export const mcasWindowDefinition: WindowTypeDefinition<McasWindowProps> = {
  type: 'mcas',
  displayName: 'MCAs',
  icon: Package,
  color: '#7A54A6',
  component: McasWindowContent,

  defaultSize: { width: 1000, height: 750 },
  minSize: { width: 600, height: 500 },

  singleton: true,

  getTitle: () => 'MCA Catalog',
  getSubtitle: () => 'Manage MCA definitions',

  serialize: () => ({}),
  deserialize: () => ({}),
};
