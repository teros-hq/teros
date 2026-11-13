/**
 * Browser Window Type Definition — Plan A of the in-Teros browser.
 *
 * A per-window web viewer: toolbar (URL bar, back/forward over the in-window
 * stack, reload, open-externally) + content area embedding the page via
 * iframe (web) / react-native-webview (native), honest about the fact that
 * many sites refuse framing.
 *
 * The window contract is deliberately just `{ url }`: when Plan B (streamed
 * remote browser) lands, the content area swaps iframe → streamed canvas
 * WITHOUT changing this contract.
 *
 * TWO BROWSERS, ONE WINDOW: inside the desktop shell the content is the
 * native WebContentsView (F2); on plain web it is the cloud browser (CLB,
 * 3-nov) — a tab of a Chrome the backend runs, streamed into a canvas — or
 * the "desktop only" empty state when the server has no cloud browser. The
 * iframe of Plan A is NEVER mounted anymore (it reloaded in a loop, 1-nov).
 * The axis is isDesktopShell() (the Electron shell's preload bridge), NOT
 * TEROS_EDITION — a desktop app can be cloud or self-hosted.
 *
 * Opened from the launcher (empty state → suggested bookmarks) or with a
 * concrete URL (agent open-window / ui-state command, etc.) — desktop only.
 */

import { Globe } from "@tamagui/lucide-icons"
import i18n from "../../i18n"
import { lazyWithRetry } from "../../lib/lazyWithRetry"
import { isDesktopShell } from "../../services/desktopBridge"
import type { WindowTypeDefinition } from "../../services/windowRegistry"
import { canonicalUrl, hostnameOf } from "./urlUtils"

/**
 * Two content components, one window type:
 *  - Teros Desktop shell (Electron) → NativeBrowserContent (F2): a REAL
 *    native browser (WebContentsView) pinned to the window's rectangle —
 *    top-level navigation, real logins, persistent session.
 *  - Plain web → BrowserWindowContent: the CLOUD browser (CLB, 3-nov) — a
 *    tab of a Chrome the backend runs, streamed into a canvas with trusted
 *    input back — or the "desktop only" empty state when the server has no
 *    cloud browser. Plan A (the iframe viewer, frozen 30-oct) is retired:
 *    the component NEVER mounts an iframe.
 * The choice is made at definition-load time (the bridge is injected by the
 * shell's preload before any React renders), so the lazy chunk for the mode
 * that is not used is never even fetched.
 */
const BrowserWindowContent = lazyWithRetry(() =>
  import("./BrowserWindowContent").then((m) => ({ default: m.BrowserWindowContent })),
)
const NativeBrowserContent = lazyWithRetry(() =>
  import("./NativeBrowserContent").then((m) => ({ default: m.NativeBrowserContent })),
)

export interface BrowserWindowProps {
  /** URL to open. Absent when opened from the launcher (empty state). */
  url?: string
  /** Page title as reported by the desktop shell (DBAB-REQ-9); native mode only. */
  title?: string
}

export const browserWindowDefinition: WindowTypeDefinition<BrowserWindowProps> = {
  type: "browser",
  audience: "user",
  displayName: "Browser",
  icon: Globe,
  phIcon: "globe",
  // Purple/200 — the dark-theme accent token (colors.ts `surfaceDark.accent`)
  color: "#9C6BFF",

  component: isDesktopShell() ? NativeBrowserContent : BrowserWindowContent,
  capabilities: { canFloat: !isDesktopShell() },

  defaultSize: { width: 900, height: 640 },
  minSize: { width: 480, height: 360 },

  // Same URL → same window (dedupe). Undefined when opened from the launcher.
  getKey: (props) => props.url || undefined,

  // @spec CLB-REQ-11 — a launcher everywhere: inside the shell it is the
  // native browser; on web it is the cloud browser (streamed from the
  // backend), or the "desktop only" state when the server has none. The
  // 1-nov gate (hidden on web) existed for the iframe reload loop, which
  // is gone with the iframe.
  isLauncher: true,

  // Page title when the shell reported one (DBAB-REQ-9), else the hostname
  // of the (canonical) URL; "Browser" for the launcher empty state.
  getTitle: (props) =>
    props.title || hostnameOf(canonicalUrl(props.url)) || i18n.t("windows.browser"),
  getSubtitle: (props) => props.url,

  serialize: (props) => ({ url: props.url, title: props.title }),
  deserialize: (data) => ({
    url: data.url as string | undefined,
    title: data.title as string | undefined,
  }),
}
