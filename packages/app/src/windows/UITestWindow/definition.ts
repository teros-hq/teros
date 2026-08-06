/**
 * UI Test Window Type Definition
 * 
 * A window for testing theme tokens, tab styles, and color contrasts
 * in both light and dark modes. Appears in the launcher.
 */

import { FlaskConical } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { UITestWindowContent } from './UITestWindowContent';

export type UITestWindowProps = {};

export const uiTestWindowDefinition: WindowTypeDefinition<UITestWindowProps> = {
  type: 'uitest',
  displayName: 'UI Test',
  icon: FlaskConical,
  color: '#5E6AD2',
  component: UITestWindowContent,

  defaultSize: { width: 600, height: 600 },
  minSize: { width: 400, height: 400 },

  isLauncher: false, // disabled — test-only, was showing in launcher

  getTitle: () => 'UI Test',

  serialize: () => ({}),
  deserialize: () => ({}),
};
