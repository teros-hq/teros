/**
 * Launcher Window Type Definition
 *
 * Shows available window types that can be opened.
 * Opens when user clicks "+" in a panel.
 */

import { LayoutGrid } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { LauncherWindowContent } from './LauncherWindowContent';

export type LauncherWindowProps = {};

export const launcherWindowDefinition: WindowTypeDefinition<LauncherWindowProps> = {
  type: 'launcher',
  displayName: 'New tab',
  icon: LayoutGrid,
  color: '#666',
  component: LauncherWindowContent,

  defaultSize: { width: 400, height: 300 },
  minSize: { width: 200, height: 200 },

  singleton: false,
  isLauncher: false, // Not shown in launcher itself

  getTitle: () => 'New tab',

  serialize: () => ({}),
  deserialize: () => ({}),
};
