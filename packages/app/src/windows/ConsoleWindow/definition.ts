/**
 * Console Window Type Definition
 */

import { Terminal } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { ConsoleWindowContent } from './ConsoleWindowContent';

export type ConsoleWindowProps = {};

export const consoleWindowDefinition: WindowTypeDefinition<ConsoleWindowProps> = {
  type: 'console',
  displayName: 'Console',
  icon: Terminal,
  color: '#06B6D4',
  component: ConsoleWindowContent,

  defaultSize: { width: 600, height: 400 },
  minSize: { width: 300, height: 200 },

  singleton: true,
  isLauncher: true,

  getTitle: () => 'Console',

  serialize: () => ({}),
  deserialize: () => ({}),
};
