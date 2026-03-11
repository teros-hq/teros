/**
 * Providers Window Type Definition
 *
 * Admin window to view and manage LLM providers and their models.
 */

import { Cloud } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ProvidersWindowContent } from './ProvidersWindowContent';

export type ProvidersWindowProps = {};

export const providersWindowDefinition: WindowTypeDefinition<ProvidersWindowProps> = {
  type: 'providers',
  displayName: 'Providers',
  icon: Cloud,
  color: '#C75450',
  component: ProvidersWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 500, height: 400 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'My Providers',
  getSubtitle: () => 'Manage your LLM API keys',

  serialize: () => ({}),
  deserialize: () => ({}),
};
