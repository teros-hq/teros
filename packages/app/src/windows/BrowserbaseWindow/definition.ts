/**
 * BrowserbaseWindow Type Definition
 *
 * Shows the Browserbase Live View iframe for an active session.
 * Opened automatically when the agent calls session-create.
 */

import { Globe } from '@tamagui/lucide-icons';
import type { WindowTypeDefinition } from '../../services/windowRegistry';
import { BrowserbaseWindowContent } from './BrowserbaseWindowContent';

export interface BrowserbaseWindowProps {
  /** Browserbase session ID */
  sessionId: string;
  /** Live View URL from Browserbase */
  liveViewUrl: string;
  /** Optional caption */
  caption?: string;
}

export const browserbaseWindowDefinition: WindowTypeDefinition<BrowserbaseWindowProps> = {
  type: 'browserbase-live-view',
  displayName: 'Browserbase',
  icon: Globe,
  color: '#6366f1', // Indigo

  component: BrowserbaseWindowContent,

  defaultSize: { width: 1280, height: 800 },
  minSize: { width: 640, height: 480 },


  // One window per session
  getKey: (props) => props.sessionId,

  getTitle: (props) => `Browser — ${props.sessionId.slice(0, 8)}`,
  getSubtitle: () => 'Browserbase Live View',

  serialize: (props) => ({
    sessionId: props.sessionId,
    liveViewUrl: props.liveViewUrl,
    caption: props.caption,
  }),

  deserialize: (data) => ({
    sessionId: data.sessionId as string,
    liveViewUrl: data.liveViewUrl as string,
    caption: data.caption as string | undefined,
  }),
};
