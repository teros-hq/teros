# Changelog

All notable changes to Teros are documented in this file.

> **Workflow:**
> Move items from `Future` into a new version block when you're ready to plan a release.
> Check them off `[x]` as they're completed. Deploy = done.

---

## v1.3.0 - Light & Dark Themes, Board Improvements & Observability

**Themes**
 - [x] Full light/dark theme system — adaptive tokens across the entire app (chat, boards, conversations, settings, all MCA renderers)
 - [x] Light mode as default (aligns with the landing page); toggle from the bottom of the sidebar
 - [x] Theme-adaptive tab bar, shadows, modal backdrops, status bar, safe zones
 - [x] SVG concave corner tabs — composite opaque colors, no transparency artifacts in light mode
 - [x] DesktopIndicator — theme-adaptive tiles replacing dark-only dots
 - [x] UITestWindow — theme preview with tab variations, token swatches & contrast tests

**What's New modal**
 - [x] Visual changelog carousel with per-user tracking ("What's New" on first launch after a release)
 - [x] Multi-language support (en/es/ko) for changelog content + all UI strings
 - [x] Icons via `@tamagui/lucide-icons` (Rocket, TrendingUp, Wrench, AlertTriangle)
 - [x] i18n all modal strings — category labels, prev/next/close/dismiss buttons, progress indicator

**Board & Tasks**
 - [x] Deep links for all 36 windows — bidirectional URL sync, shareable/bookmarkable
 - [x] TaskDetailPanel redesigned — tabs for Instructions, Progress, and Conversation
 - [x] Sticky title and tags while scrolling task content
 - [x] Progress notes with avatars, collapsible markdown, and fade gradients
 - [x] Separate Instructions field on tasks (distinct from description)
 - [x] Board columns scroll properly when a task detail panel is open
 - [x] Unified agent selector with play/stop controls
 - [x] board-manager: update-project, delete-project, update-board-config tools

**Voice mode**
 - [x] Silent mode server-side enforcement (AF-4)
 - [x] Voice transcripts persisted to session store so text agent can see them (AF-5)
 - [x] Pre-startSession voice errors surfaced + 400/500 WS close codes mapped (AF-3, AF-7)
 - [x] Voice worker runs in conversation channel for full history access (AF-2)
 - [x] Screen awake during voice sessions via wake lock
 - [x] Voice mode colors migrated to design system tokens
 - [x] Web tooltip for voice button in chat header
 - [x] Prevent duplicate responses when voice mode is active

**UI polish**
 - [x] Consistent loading spinners across the app (AppSpinner, indigo #5E6AD2)
 - [x] Click outside the task panel to close it
 - [x] FileViewer HTML content adapts to window width
 - [x] Chat fonts migrated to DM Sans + Newsreader + JetBrains Mono
 - [x] 24 MCA tool renderers migrated to theme-adaptive tokens
 - [x] Conversation titles fontWeight normalized in navbar + ConversationsWindow

**Observability — Latitude OTLP export (F3a + F4)**
 - [x] Structural OTLP export of agent traces to Latitude (tokens, latency, tools — no text)
 - [x] Gated by env vars (`LATITUDE_EXPORT_URL/TOKEN/PROJECT`) + feature flag `observability.latitude-export`
 - [x] Latitude score emitter — scores every turn incl. ZDR default (F4·C0)
 - [x] Session Trace signal badge — webhook + disposable index + frontend badge (F4·C1)
 - [x] Prompt-regression gate — contract + behavioural (F4·C3)
 - [x] Latitude signals dashboard (F4·C2)
 - [x] Runbook for swapping export target (Latitude → Langfuse/Arize/Tempo in ~3 lines)

**Compaction & context fixes**
 - [x] Count full prompt with provider-aware tokenizer for compaction trigger (TER-705)
 - [x] Keep protected messages after compaction (CTX-002 / TER-704)
 - [x] Detect context-length overflow structurally across all LLM adapters (CTX-007 / TER-706)
 - [x] Elide oversized tool-call args from LLM history at the prompt choke point (CTX-016)
 - [x] Emit valid JSON when truncating oversized OpenRouter tool-call args (CTX-016)
 - [x] Kill-switch `TOOL_ARG_EVICTION_ENABLED` documented

**Feature flags**
 - [x] Fix: `featureFlags.changed` push now resolves with workspace context — workspace overrides no longer invisible until reload (TER-460)

**MCA Health dashboard**
 - [x] MCA tool health persistence + schema read path (backend)
 - [x] MCA health dashboard (read-only) with live test engine
 - [x] Render + contract test suites (frontend)

**Integrations**
 - [x] Make.com MCA v2.0 — full scenario lifecycle management
 - [x] notify-by-email tool in messaging MCA

**Other fixes**
 - [x] Auth: extract locale from profile in normalizeAuthUser
 - [x] Conversation: a queued message never aborts in-flight tool calls
 - [x] Agent-to-agent messages use explicit senderType + senderId
 - [x] Billing: guard Stripe chargeInvoice against amount divergence (TER-702)
 - [x] Shared: normalize OperationTimeoutError as TIMEOUT, not unknown (#389)
 - [x] EAS: iOS EAS builds work from the monorepo

## Future

**UI**
 - [ ] @mention system — full mention resolution and agent-to-agent addressing in conversations

**Permissions** (moved from v1.2.0 — both need a rethink/design pass before implementing)
 - [ ] Redo the permission request widget
 - [ ] Auto mode in permissions

**Voice**
 - [ ] Event queueing in voice conversations — events arriving while the
   assistant is speaking (e.g. tool results, permission requests) interrupt the
   TTS playback mid-sentence, causing abrupt cutoffs and disjointed resume.
   Events should be queued and processed after the current speech turn
   completes, the same way normal text conversations defer incoming messages
   until the current turn finishes (post_turn_fifo / boundary_aware strategy).

**Conversations / History**
 - [ ] INVESTIGATE: The Alice agent does not have full access to conversation history.
   When the user asks about previous conversations (e.g. the containers and scalability topic),
   list-channels does not return all existing channels. Investigate:
   - Are conversations being saved correctly in the DB?
   - Does the agent have limited permissions to access certain channels?
   - Is there a filter by workspace, date or conversation type?
   - Are old conversations archived or deleted automatically?
   Possibly related to container scalability issues if conversation storage
   is distributed or sharded.

## v1.2.2 - 

 - [ ] 

## v1.2.1 - Multi-Host Execution & Inline Forms

**Forms**
 - [x] Inline user forms — `request-user-input` built-in tool + FormWidget in the conversation
 - [x] Wizard presentation: question-by-question mode, review step, choice auto-advance, progress in header, i18n copy

**Infra — core/execution separation**
 - [x] Container agent daemon on the execution host (phase 0) — the core no longer talks to Docker directly
 - [x] Remote execution hosts parameterized; prod containers run on a dedicated host (int5)
 - [x] Multi-host deploy — execution host updated in parallel, runtime image builds moved off the core
 - [x] Container hardening for high-concurrency days — container cap, CPU/memory limits, idle timeouts, async Docker calls
 - [x] Egress firewall for egress MCAs (SSRF containment at the network layer): remote core callback allowed, replies to core-initiated connections accepted (conntrack), rules persist across reboots
 - [x] Terminal works against a remote execution host (`TERMINAL_DOCKER_HOST`) and gets a real TTY in `docker exec`

**MCAs**
 - [x] Self-heal stale container entries on CONNECTION_FAILED; aligned idle timeouts
 - [x] Unconnected accounts report `AUTH_REQUIRED` instead of `SYSTEM_CONFIG_MISSING`
 - [x] stdio MCA spawn fixes — `node_modules/.bin` in PATH, ESM `__dirname`

**Permissions**
 - [x] Permission widget rehydrates after reconnect (pending permission persisted through stream desync)
 - [x] Queue poller respects the interrupt strategy — tools no longer die with "cancelled before completion" while waiting for a grant (headless/voice)
 - [x] `alwaysAsk` on app-uninstall; removed from access-grant and skill-grant-access

**UI**
 - [x] Admin-only windows (feature flags, session trace) hidden from the launcher for non-admins
 - [x] PWA serves the cached app shell on offline navigations instead of a blank "Offline" page


## v1.2.0 - UX Improvements

** MCAs **
 - [x] Whatsapp auth simplification
 - [x] Informative message in whatsapp auth tab

 - [x] Superagent has all apps

** Permissions **
 - [x] Read-only mode defaults to allowed
 - [x] UX: No countdown in permissions
 - [x] The agent always tries to use the apps it has, and if it can't access an
   app — because it errors or because it isn't installed — it stops there,
   unless the user tells it to look for a workaround.

** Providers **
 - [x] Add GLM-5.2 to Fireworks + Teros (base + Fast router)
 - [x] Add Kimi 2.7 Fast to Fireworks + Teros (Code Fast router)

 - [x] If the app doesn't exist in the workspace, the agent asks for permission to install it


## v1.1.1 - Board Autorun & Sync

**Workspaces & Agents**
 - [x] Full mobile parity for workspace switching, skills, and projects

**Boards**
 - [x] Board Autorun — supervisor agent with concurrent task assignment and worker slots

**UI**
 - [x] File Browser — full navigation, preview, and file opener

 - [x] Markdown Viewer — standalone viewer window with file opener registration

**Integrations**
 - [x] Notion MCA — extended tool coverage and UX improvements

**MCA tools**
 - [ ] Move tool `description` strings to a translation system — today they are
   hardcoded English in each `ToolConfig` and shown verbatim in the permissions
   UI and Tool Call Cards
 - [ ] Curate MCP annotations per MCA (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`, `irreversible`) — the 2026-07-04 bake made
   `readOnlyHint` explicit everywhere from the retired name heuristic; each MCA
   still needs a manual review pass
 - [ ] Tool naming standardization — kebab-case everywhere, drop service
   prefixes (`linear-*`, `railway-*`, `monday_*`), uniform `-health-check`,
   remove orphaned tools.json entries (`linear-delete-project`)

**Tooling — pinned dependencies**
 - `@react-native-async-storage/async-storage@2.2.0` is pinned in
   `packages/app/package.json`. v3.x is incompatible with Expo SDK 54+
   (see [expo/expo#43757](https://github.com/expo/expo/issues/43757)).
   Bump together with the next Expo SDK upgrade — without that, the
   theme persistence path silently downgrades to in-memory.


## v1.1.0 - Workspaces & Projects

**Workspaces**
 - [x] Private Workspace — auto-created on registration, always first, non-deletable

 - [x] Superagents — global agents visible across all workspaces, shown first in Navbar

 - [x] Workspace zone in Navbar — conversations, agents, apps and skills scoped to active workspace

 - [x] Global workspace selector with backdrop and sorted list

 - [x] `<context>` block injected into system prompt (channel, time, user, workspace, project)

**Projects**
 - [x] Project dashboard window with board, agents and activity panels

 - [x] `/project/[projectId]` route and Navbar section with inline create

 - [x] Project context injected into system prompt for associated conversations

 - [x] Migration script to create projects from existing boards

**Skills**
 - [x] Skills backend — model, service, handlers and WsRouter registration

 - [x] Skills injected into agent system prompt at runtime

 - [x] SkillsWindow — create, edit, delete and assign skills to agents

 - [x] AgentWindow Skills tab — assign and enable/disable skills per agent

 - [x] Skill management tools in core MCA

**Navbar**
 - [x] Fused Teros + superagent header with Account section and clean footer

 - [x] @mention system — hook, dropdown, chips and Lexical composer input

 - [x] New conversation button (+) on superagent header

 - [x] Projects section always visible with inline create

**Desktop**
 - [x] Persist tiling layout per user/workspace — restored on reconnect

 - [x] Drag tab to desktop dot to move windows cross-desktop

 - [x] Custom ghost image pill when dragging tabs

**Scheduler**
 - [x] Unified scheduler events with MCA event subscription system

 - [x] Auto-create and clean up channel subscriptions with reminders and recurring tasks

**New integrations**
 - [x] Railway MCA — deployment management with UI renderer

 - [x] Render MCA — with UI renderer

 - [x] GitHub MCA — migrated to GitHub App, added `clone-repo` tool

 - [x] Figma MCA — migrated to OAuth2, added `file_variables:read` scope

**Infrastructure**
 - [x] Migration system with TTL index as first migration

 - [x] PubSub system — `PubSubService`, `channel_subscriptions`, unified pub/sub across voice, file watcher and scheduler

 - [x] MCA Event Subscription Service wired into backend (`/api/mca-event`)

 - [x] `channel_started` / `channel_finished` events rendered in chat with link

 - [x] `get-blocks` tool with pagination for Notion MCA

 - [x] User profile stats with real data (chats, agents, days active)

 - [x] Badges system — `founding_partner`, `early_bird`

 - [x] File Browser and Markdown Viewer windows (foundation)

**Fixes**
 - [x] Permission request system — stop typing on pending, handle tool status updates, fix race condition

 - [x] Agents can read their own active channel correctly

 - [x] Superagents included in agent list and new conversation modal

 - [x] Skill injection scoped to active workspace

 - [x] Workspace app resolution with legacy `ownerId` fallback

 - [x] `workspaceId` passed correctly through delegate-task and sub-conversations

 - [x] Desktop layout restored correctly on workspace switch

 - [x] Blank window on stale `activeWindowId` resolved

 - [x] Non-ASCII display names encoded correctly in email headers

 - [x] Duplicate tool names detected before LLM call

---

## v1.0.0 - Hello Private Beta

**Voice**
 - [x] Voice unified into chat — inline mode, no separate window

 - [x] Real-time broadcast with 🎙️ indicator in chat bubbles

 - [x] Voice session persistence, auto-reconnect and transcript view

 - [x] Voice selector with curated options, mute button and interruption handling

**Delegation**
 - [x] Sub-conversation visibility toggle and permission escalation to parent channel

 - [x] Forward sub-agent turns to parent channel automatically

 - [x] `delegate-task` tool with headless conversation creation

**Boards**
 - [x] Runner/Manager role separation (`board-runner` / `board-manager` MCAs)

 - [x] Task dependency management with circular dependency detection

 - [x] Drag & drop reorder with ghost card effect

 - [x] Tag filters, text search and hidden task count

 - [x] Auto-dispatcher with worker slots and play/pause

 - [x] Board deep links and double-pane state isolation

**New integrations**
 - [x] Browserbase MCA — cloud browser sessions with Live View (16 tools)

 - [x] ClickUp MCA — full OAuth2 integration (17 tools)

 - [x] GitHub MCA — rewritten with OAuth2 (25 tools)

 - [x] Outlook MCA — Microsoft Outlook via Graph API

 - [x] Homey MCA — smart home integration with token refresh

 - [x] Figma MCA — initial integration

 - [x] Notion MCA — migrated from API key to OAuth2

 - [x] Docker environment manager MCA — Phase 1 PoC

**Providers**
 - [x] Google Gemini — 2.0 Flash, 2.5 Flash, 2.5 Pro and latest 3.x models

 - [x] Default provider/model system with UI controls

**UI**
 - [x] Permission system — approval queue, sound notifications and escalation

 - [x] `send-html-file` tool with FileViewer window and real-time file watching

 - [x] Infinite scroll upward with stable content position

 - [x] Per-tab navigation history with back/forward; Cmd+Click opens in new tab

 - [x] User badges: `founding_partner`, `early_bird`

 - [x] Activity bars (7 days) in user cards

 - [x] Admin users panel with grant-access action

 - [x] Access-granted email via Resend

**Infrastructure**
 - [x] `WsFramework` — `WsRouter`, `SubscriptionManager` and domain migration

 - [x] Paginate channel list with keyset cursor

 - [x] `WsLogger` NDJSON with client IP and batch `getAgentApps` with TTL cache

 - [x] Production backup script with database and volumes

 - [x] Volume migration and verification scripts

 - [x] Provider management tools in core MCA

 - [x] `accessGranted` flow replacing invitation system

 - [x] FSL-1.1-Apache-2.0 license and CONTRIBUTING.md

---

## v0.2.0 - Hello Stable

 - [x] `FilesystemRenderer` in chat — syntax highlighting and inline diff

---

## v0.1.0 - Hello Teros

 - [x] Initial internal release

---

[v1.1.0]: https://github.com/teros-hq/teros/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/teros-hq/teros/compare/v0.2.0...v1.0.0
[v0.2.0]: https://github.com/teros-hq/teros/compare/v0.1.0...v0.2.0
[v0.1.0]: https://github.com/teros-hq/teros/releases/tag/v0.1.0
