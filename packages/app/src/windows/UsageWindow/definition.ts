/**
 * Usage Window Definition
 *
 * Admin window for viewing LLM usage analytics and costs
 */

import { BarChart3 } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { UsageWindowContent } from './UsageWindowContent';

export type UsageWindowProps = {};

export const usageWindowDefinition: WindowTypeDefinition<UsageWindowProps> = {
  type: 'usage',
  displayName: 'Usage & Costs',
  icon: BarChart3,
  color: '#22C55E',
  component: UsageWindowContent,

  defaultSize: { width: 900, height: 700 },
  minSize: { width: 600, height: 400 },

  singleton: true,

  getTitle: () => 'Usage & Costs',
  getSubtitle: () => 'LLM usage analytics',

  serialize: () => ({}),
  deserialize: () => ({}),
};
