#!/usr/bin/env bun

/**
 * mca.teros.ui — UI Control
 *
 * Read the user's live interface state and drive their screens in real time
 * (spec 20261022_ui-state-mca.md, REQ-5). Thin wrapper over the backend's
 * ui.* domain via the admin_request bridge:
 *
 *   ui-state        → ui.get-state   (read-only: the live desktop, per device)
 *   ui-open         → ui.command open-window        (broadcast → all devices)
 *   ui-close        → ui.command close-window       (broadcast)
 *   ui-update-props → ui.command update-window-props (broadcast, props MERGE)
 *   ui-focus        → ui.command focus-window       (frontend action → active)
 *   ui-set-desktop  → ui.command set-active-desktop (frontend action → active)
 *
 * Command classes (REQ-4 / Q1): broadcast commands change window state on
 * EVERY device (each applies the identical change, focus included — Q8);
 * frontend actions change the VIEW of one device (the active one by default).
 *
 * The MCA owns no data and no logic beyond parameter validation and outcome
 * phrasing — authz (workspace write access), rate limits and delivery live in
 * the backend domain.
 */

import { McaServer } from "@teros/mca-sdk"
import {
  browserClick,
  browserCloseTab,
  browserControl,
  browserGetState,
  browserListTabs,
  browserOpenTab,
  browserOpenUrl,
  browserPressKey,
  browserScreenshot,
  browserScroll,
  browserType,
  healthCheck,
  uiClose,
  uiCreateDesktop,
  uiFocus,
  uiOpen,
  uiRemoveDesktop,
  uiSetDesktop,
  uiSetNavbar,
  uiSetTheme,
  uiState,
  uiUpdateProps,
} from "./tools"
import { connectWsClient } from "./lib"

const server = new McaServer({
  id: "mca.teros.ui",
  name: "UI Control",
  version: "1.3.0",
})

// Internal
server.tool("-health-check", healthCheck)

// Read
server.tool("ui-state", uiState)

// Commands — broadcast (window state → all devices)
server.tool("ui-open", uiOpen)
server.tool("ui-close", uiClose)
server.tool("ui-update-props", uiUpdateProps)

// Commands — frontend actions (view of one device)
server.tool("ui-focus", uiFocus)
server.tool("ui-set-desktop", uiSetDesktop)

// Commands — desktop & view control (agent UI control)
server.tool("ui-create-desktop", uiCreateDesktop)
server.tool("ui-remove-desktop", uiRemoveDesktop)
server.tool("ui-set-navbar", uiSetNavbar)
server.tool("ui-set-theme", uiSetTheme)

// Browser control (Teros Desktop F3) — request-response over the UI channel;
// the desktop's Electron main process executes via CDP with consent (OFF by
// default) + take-over fence.
server.tool("browser-get-state", browserGetState)
server.tool("browser-click", browserClick)
server.tool("browser-type", browserType)
server.tool("browser-screenshot", browserScreenshot)
server.tool("browser-open-url", browserOpenUrl)
server.tool("browser-control", browserControl)

// Browser tabs + more inputs (DBAC-REQ-14): open a tab in a pane beside the
// user, list and close tabs, scroll, press a key.
server.tool("browser-open-tab", browserOpenTab)
server.tool("browser-list-tabs", browserListTabs)
server.tool("browser-close-tab", browserCloseTab)
server.tool("browser-scroll", browserScroll)
server.tool("browser-press-key", browserPressKey)

server.start().catch((error) => {
  console.error("Failed to start MCA:", error)
  process.exit(1)
})

// Connect the admin_request bridge eagerly. The handshake token embedded in
// MCA_WS_URL expires ~30s after spawn (McaConnectionManager tokenExpiryMs) and
// the SDK's reconnect loop replays the same dead URL, so a process that never
// calls backendAction within that window stays a zombie forever — no tool can
// reach the backend. Spawning is always followed by a tool call in practice,
// but an eager connect makes the bridge robust regardless of call timing.
// @todo alice - 2026.10.23 : upstream this eager-connect into the SDK's
// McaServer.start() so every bridge MCA gets it for free
connectWsClient().catch((error) => {
  console.error("[mca.teros.ui] Eager WS bridge connect failed:", error)
})
