/**
 * BrowserbaseWindow Type Definition
 *
 * Shows the Browserbase Live View iframe for an active session.
 * Opened automatically when the agent calls session-create.
 */

import { Globe } from "@tamagui/lucide-icons"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
const BrowserbaseWindowContent = lazyWithRetry(() =>
  import("./BrowserbaseWindowContent").then((m) => ({ default: m.BrowserbaseWindowContent })),
)

export interface BrowserbaseWindowProps {
  /** Browserbase session ID */
  sessionId: string
  /** Live View URL from Browserbase */
  liveViewUrl: string
  /** Optional caption */
  caption?: string
}

export const browserbaseWindowDefinition: WindowTypeDefinition<BrowserbaseWindowProps> = {
  type: "browserbase-live-view",
  audience: "user",
  displayName: "Browserbase",
  icon: Globe,
  phIcon: "globe",
  color: "#6F27FF",

  component: BrowserbaseWindowContent,

  defaultSize: { width: 1280, height: 800 },
  minSize: { width: 640, height: 480 },

  // One window per session
  getKey: (props) => props.sessionId,
  noPreview: true, // Live browser view — never a preview tab (preview-tabs.md)

  getTitle: (props) => `Browser — ${props.sessionId.slice(0, 8)}`,
  getSubtitle: () => "Browserbase Live View",

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
}
