/**
 * Catalog Window Type Definition
 *
 * Catalog de aplicaciones disponibles para instalar.
 */

import { Store } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { CatalogWindowContent } from './CatalogWindowContent';

export interface CatalogWindowProps {
  /** Workspace context */
  workspaceId?: string;
  /** Initial category filter */
  category?: string;
  /** Initial search query */
  search?: string;
}

export const catalogWindowDefinition: WindowTypeDefinition<CatalogWindowProps> = {
  type: 'catalog',
  displayName: 'Catalog',
  icon: Store,
  color: '#10B981',
  component: CatalogWindowContent,

  defaultSize: { width: 900, height: 600 },
  minSize: { width: 600, height: 400 },

  isLauncher: true,

  getTitle: () => i18n.t("windows.catalog"),

  serialize: (props) => ({
    workspaceId: props.workspaceId,
    category: props.category,
    search: props.search,
  }),
  deserialize: (data) => ({
    workspaceId: data.workspaceId,
    category: data.category,
    search: data.search,
  }),
};
