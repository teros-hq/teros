/**
 * MCAs Window Type Definition
 *
 * Admin window to view and manage the MCA catalog.
 */

import { Package } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { McasWindow } from './McasWindow';

export type McasWindowProps = {};

export const mcasWindowDefinition: WindowTypeDefinition<McasWindowProps> = {
  type: 'mcas',
  displayName: 'MCAs',
  icon: Package,
  color: '#7A54A6',
  component: McasWindow,

  defaultSize: { width: 1000, height: 750 },
  minSize: { width: 600, height: 500 },


  getTitle: () => i18n.t("windows.mcaCatalog"),
  getSubtitle: () => i18n.t("windows.mcaCatalogSub"),

  serialize: () => ({}),
  deserialize: () => ({}),
};
