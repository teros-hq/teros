# mca.teros.ui

UI Control — see what the user is seeing right now and drive their interface
in real time (spec `docs/specs/20261022_ui-state-mca.md`, REQ-5).

The Teros frontend is a desktop of tiled windows; the backend holds a live
mirror of it (per device), and this MCA exposes it to agents: read the state,
open/close/update windows everywhere, focus windows and switch desktops on
the active device.

## Tools

| Tool | Backend action | Class | Purpose |
|---|---|---|---|
| `-health-check` | — | — | Reports bridge WS status to the backend |
| `ui-state` | `ui.get-state` | read | What the user is seeing now, per device: windows (type + props, enriched with agentName/channelTitle/session titles/projectName), layout with ratios, focused window, active desktop, device label/online, and the live `windowTypes` catalog |
| `ui-open` | `ui.command open-window` | broadcast | Open (and focus) a window on EVERY connected device; existing same-key window is focused, not duplicated. With `desktopId`: targeted open on that desktop (view switches to it; unknown → `UI_UNKNOWN_DESKTOP`). With `pane` (left/right/top/bottom): the window gets its own split pane beside the desktop's active pane |
| `ui-close` | `ui.command close-window` | broadcast | Close a window on every device |
| `ui-update-props` | `ui.command update-window-props` | broadcast | MERGE a window's props on every device |
| `ui-focus` | `ui.command focus-window` | frontend action | Focus a window on the active device (or an explicit deviceId) |
| `ui-set-desktop` | `ui.command set-active-desktop` | frontend action | Switch desktop on the active device (or an explicit deviceId) |
| `ui-create-desktop` | `ui.command create-desktop` | frontend action | New empty desktop at the end (cap 10, optional name), switches the user to it |
| `ui-remove-desktop` | `ui.command remove-desktop` | frontend action | Remove a desktop — windows migrate to the previous one; never the last one |
| `ui-set-navbar` | `ui.command set-navbar-collapsed` | frontend action | Collapse / expand / toggle the left navbar (persists) |
| `ui-set-theme` | `ui.command set-theme` | frontend action | Dark / light / toggle the theme (persists) |

### Browser control (Teros Desktop F3 + DBAC) — the user's browser tabs inside the desktop app

Request-response over the UI channel (`correlationId` + `ui.command-result`, 25 s timeout); the desktop's
Electron main process executes via CDP (`teros-desktop/src/browserExecutor.js`). **Inputs need the user's
consent toggle in the tab's toolbar (OFF by default) and a free take-over fence** (the person using the tab
always wins). Looking never needs consent. `tabId` = the windowId of a browser window.

| Tool | Command | Purpose |
|---|---|---|
| `browser-open-tab` | `open-window` (browser, pane right) + `ui.get-state` poll | Open a NEW tab beside the user (default pane: right), wait for the device to report it, return its `tabId` |
| `browser-list-tabs` | `ui.get-state` | The browser tabs per device: tabId, url, title, focused |
| `browser-close-tab` | `close-window` | Close a tab |
| `browser-get-state` | `browser.get-state` | Page url/title, control status, a11y snapshot with `[ref=eNN]`, optional screenshot — always allowed |
| `browser-screenshot` | `browser.screenshot` | Downscaled JPEG attachment — always allowed |
| `browser-open-url` | `browser.open-url` | Top-level navigation of the tab |
| `browser-click` | `browser.click` | Trusted click by ref or x,y |
| `browser-type` | `browser.type` | Trusted text input (ref focuses + clears first; submit presses Enter) |
| `browser-press-key` | `browser.press-key` | One key (Enter, Escape, Tab, Arrow*, … or a character) with Alt/Control/Meta/Shift |
| `browser-scroll` | `browser.scroll` | Trusted wheel scroll: direction + amount, optionally over a ref |
| `browser-control` | `browser.control` | Consent + fence status; advisory take/release |

Typical flow: `browser-open-tab { url }` → `browser-get-state { tabId }` → `browser-click`/`browser-type`/
`browser-scroll`/`browser-press-key` → `browser-screenshot` to verify → `browser-close-tab`. Errors come back
phrased: `agent_control_disabled` (ask the user to turn the toggle on), `human_has_control` (wait),
`ref_not_found` (take a fresh snapshot), `browser_not_open`, `UI_COMMAND_TIMEOUT`.
Spec: `docs/specs/20261031_desktop-browser-agent-control.md` (DBAC) · F3: `20261031_desktop-f3-browser-control.md`.

Every command tool accepts `target`: `'all'` | `'active'` | a deviceId from
`ui-state`. Defaults per command class: broadcast → `all`, frontend actions →
`active` (REQ-4).

## The acceptance flow — "on desktop 3, to-do on the right, home on the left"

Natural conversation → tool sequence (no user interaction needed):

```
ui-state                          → read desktopIds + windowTypes
ui-create-desktop { name: "…" }   → if desktop 3 doesn't exist (cap 10)
ui-open { windowType: "home",  desktopId: "desktop_2_x", pane: "left" }
ui-open { windowType: "todo",  desktopId: "desktop_2_x", pane: "right" }
ui-close   { windowId: "…" }      → close any window
ui-set-navbar { collapsed: true } → collapse the left navbar
ui-set-theme { theme: "light" }   → light mode
```

An empty target desktop absorbs the first pane-commanded window (it fills the
desktop whole); the second one splits around it — both orders converge to the
same left/right layout.

## Architecture

```
agent ──HTTP /tools/call──▶ MCA process ──WS /mca (admin_request)──▶ backend ui.* domain
                                                                        │
                                        ┌── ui.get-state ◀──────────────┤  UiStateManager
                                        │   (read-time enrichment)      │  (in-memory mirror,
user's screens ◀── ui_command events ───┤                               │   per device)
(PubSub topics, live WS)                 └── ui.command → pubsub ───────┘  authz + rate limits
```

- `src/lib.ts` is the `admin_request` bridge (same pattern as
  `mca.teros.terminal`): the backend resolves the app owner's userId for
  authz, and every call passes the workspace explicitly.
- The MCA owns NO data: validation, target defaults and outcome phrasing
  only. Authz (workspace **write** access — a screen can show sensitive
  content, terminal-domain precedent D6), rate limits (20 commands/min,
  5 opens/min per app) and delivery live in the backend domain
  (`packages/backend/src/handlers/domains/ui`).
- Window types are DYNAMIC (Q4): each device reports its own registry in
  `ui-state`'s `windowTypes`; tool descriptions stay generic and point at it.

## Outcome semantics (important for agents)

- `delivered: 0` is surfaced as an explicit, unmissable outcome: **the user
  has no connected client — nothing was opened/changed on any screen**. It is
  not an error and nothing is pending.
- Delivery ≠ application: a window closed between `ui-state` and
  `ui-close`/`ui-focus` is a client-side no-op; the result still reports how
  many clients received the command.
- Broadcast `open-window` with `focus: true` (default) focuses the window on
  EVERY receiving device (Q8) — all devices apply the identical change.

## Permissions (Q2, Pablo 2026-10-22)

`ui-state` is read-only → seeds **allow**. Every command tool seeds **ask** —
uniformly, including workspace agents. The user can change them per app in
the permissions panel.

## Testing

- **Unit** (`test/unit/tools.test.ts`, bun): tool handlers against a fake
  bridge — parameter validation, `ui.command` mapping (command kind, payload,
  target), `ui.get-state` normalization, and the `delivered: 0` phrasing.
- **Integration** (`packages/backend/tests/integration/ui-mca.test.ts`, bun):
  spawns the real MCA process against the TestServer bridge with the real
  `ui.*` domain — full tool flow with two fake devices (AC-1, AC-3, AC-4,
  AC-5, AC-6, AC-10).

## Out of scope (Phase 2)

Backend domain, frontend `uiSync`, `ui.watch` event subscriptions,
`switch-workspace` / `set-active-tab` frontend actions.
