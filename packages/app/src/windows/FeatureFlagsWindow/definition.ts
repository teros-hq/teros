/**
 * Feature Flags Window Type Definition
 *
 * Admin window to view and manage feature flags.
 * Only visible in the navbar for users with role "admin" or "super".
 */

import { Flag } from '@tamagui/lucide-icons';
import i18n from '../../i18n';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { FeatureFlagsWindowContent } from './FeatureFlagsWindowContent';

export type FeatureFlagsWindowProps = {
  /** Optional initial search query */
  search?: string;
};

export const featureFlagsWindowDefinition: WindowTypeDefinition<FeatureFlagsWindowProps> = {
  type: 'feature-flags',
  displayName: 'Feature Flags',
  icon: Flag,
  color: '#F59E0B',
  component: FeatureFlagsWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  isLauncher: true,
  adminOnly: true,

  getTitle: () => i18n.t("windows.featureFlags"),
  getSubtitle: () => i18n.t("windows.featureFlagsSub"),

  serialize: (props) => ({
    search: props.search,
  }),
  deserialize: (data) => ({
    search: data.search,
  }),
};
