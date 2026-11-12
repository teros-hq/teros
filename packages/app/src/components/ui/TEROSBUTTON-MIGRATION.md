# TerosButton - Phase 2 migration backlog

Generated: 2026-10-06 by nira. Census: every file under src/ and app/ rendering a Tamagui Button (67 files). This list is the Phase 2 queue - migrate gradually, by classes (see below), after Pablo validates the feel of the Phase 1 deployments (composer send + onboarding CTA) on raw-os.

## Already migrated (Phase 1 - now unconditional, flag removed 2026-10-06)

- components/InputComposer.web.tsx - composer send (icon-only, primary/violet/lg, wandering blur only - icon-only primary does NOT smoke by design)
- components/onboarding/StepFooter.tsx - specialCta branch only (secondary + fill violet + smoke + travelling ink; back/skip/continue untouched)

## EXCLUDED - do not migrate

- components/chat/StopButton.tsx - its red is a semantic safety signal, deliberately off-palette (same principle as DS status colors). The DS has no red tone and must never have one. NOT part of this migration.
- components/ui/TerosButton.tsx and components/ui/TerosButton.web.tsx - the component itself

## Migration classes

- Primary CTAs (submit / confirm / primary action in a modal or form) - variant primary, full effect available (wandering blur; smoke only when secondary)
- Secondary CTAs (cancel / skip / tertiary actions) - variant secondary + fill when the button is the hero of its surface - smoke + travelling ink
- Utility icon buttons (toolbar toggles, small actions) - icon-only, tone by context; wandering blur only
- Destructive actions - keep Tamagui styling until the DS defines a destructive tone (do NOT improvise one)

## Full census (67 files, sorted)

### app/ (auth screens) - MIGRATED 2026-10-06 (CTAs only)
- app/(auth)/login/email.tsx - Sign In CTA (primary/violet/lg/block, arrow-right, loading)
- app/(auth)/login/index.tsx - Sign in with email (secondary/violet/lg/block, no fill)
- app/(auth)/login/signup.tsx - Create Account CTA (primary/violet/lg/block, arrow-right, loading)
- app/(auth)/login/welcome.tsx - Get Started CTA (primary/violet/lg/block, arrow-right, loading)
- Social login buttons (Google/GitHub/Microsoft) stay in Tamagui: custom brand-icon components; the engine only draws Phosphor glyphs.
- Chromeless text links (sign up / forgot password) are not buttons - untouched.

### components/
MIGRATED 2026-10-06 (CTAs only):
- components/billing/BoostModal.tsx - internal PrimaryButton wrapper -> TerosButton primary/violet/md/block + loading (44->44 md 1:1, all 4 call sites at once: boost-request, boost-buy, boost-done-close, boost-unavailable-close). Icon-only steppers (boost-hours-dec/inc) and chromeless circular close stay in Tamagui (icon-only class).
- components/billing/HoursExhaustedWidget.tsx - upgrade CTA -> primary/violet/sm; boost CTA -> secondary/violet/sm, no fill (alternative path).
- components/billing/PaymentDueWidget.tsx - regularize CTA -> primary/violet/sm.
- components/billing/PaymentMethodSetup.tsx - save CTA -> primary/violet/md/block + loading; cancel -> secondary/violet/md/block (testID payment-method-cancel added). Init-error cancel (rare error state, 40px) stays in Tamagui.
EXCLUDED (stay in Tamagui):
- BillingWarningBanner.tsx - amber CTA (indicators.risk) is semantic status, same principle as StopButton; chromeless circular dismiss stays.
- Icon-only steppers and chromeless closes across billing - icon-only class, revisit with group 3.
- components/chat/bubbles/AudioBubble.tsx
- components/chat/bubbles/HtmlBubble.tsx
- components/chat/bubbles/VideoBubble.tsx
- components/chat/bubbles/VoiceBubble.tsx
- components/chat/ChatView.tsx
- components/chat/HardCancelModal.tsx
- components/chat/PrePublishWarningDialog.tsx
- components/chat/StopButton.tsx
- components/ContextEditor.tsx
- components/dataRetention/RetentionConfirmModal.tsx
- components/ErrorBlock.tsx
- components/InfoModal.tsx
- components/InputComposer.tsx
- components/InputComposer.web.tsx
- components/MessageFeedback.tsx
- components/MoveToWorkspaceModal.tsx
- components/NewConversationModal.tsx
- components/onboarding/AddProviderForm.tsx
- components/onboarding/StepFooter.tsx
- components/ProviderErrorWidget.tsx
- components/ui/SharePopover.tsx
- components/VoiceRecordingBar.tsx
- components/voice/VoiceControlsBar.tsx
- components/voice/VoiceErrorBanner.tsx
- components/workspace/WindowContent.tsx

### windows/
- windows/AgentCoresWindow/AgentCoresWindowContent.tsx
- windows/AgentUsageWindow/AgentActivityContent.tsx
- windows/AgentUsageWindow/components/ToolsPanel.tsx
- windows/AgentWindow/AgentWindowContent.tsx
- windows/BillingRequestsWindow/BillingRequestsWindowContent.tsx
- windows/BrowserbaseWindow/BrowserbaseWindowContent.tsx
- windows/CodeEditorWindow/CodeEditorWindowContent.tsx
- windows/ConversationsWindow/ConversationsWindowContent.tsx
- windows/FeatureFlagsWindow/FeatureFlagsWindowContent.tsx
- windows/FileBrowserWindow/FileBrowserWindowContent.tsx
- windows/FileViewerWindow/FileViewerWindowContent.tsx
- windows/LatitudeSignalsWindow/LatitudeSignalsWindowContent.tsx
- windows/MarkdownViewerWindow/MarkdownViewerWindowContent.tsx
- windows/McasWindow/McaInputForm.tsx
- windows/McasWindow/McaRow.tsx
- windows/McasWindow/McaStatusSheets.tsx
- windows/McasWindow/McasWindowContent.tsx
- windows/McasWindow/McasWindow.tsx
- windows/ModelHealthWindow/ModelHealthWindowContent.tsx
- windows/MonitoringWindow/MonitoringWindowContent.tsx
- windows/PendingApprovalsWindow/PendingApprovalsWindowContent.tsx
- windows/ProfileWindow/ProfilePlanSection.tsx
- windows/ProfileWindow/ProfileWindowContent.tsx
- windows/ProvidersWindow/ProvidersWindowContent.tsx
- windows/SessionTraceWindow/SessionTraceWindowContent.tsx
- windows/TerminalWindow/TerminalWindowContent.tsx
- windows/TodoWindow/TodoWindowContent.tsx
MIGRATED 2026-10-06 (CTAs only):
- windows/UsersWindow/billing/BillingEditForm.tsx - cancel -> secondary/violet/sm; save -> primary/violet/sm + loading; manage-configs -> primary/violet/sm.
- windows/UsersWindow/billing/BillingSummary.tsx - audit + export -> secondary/violet/sm; edit -> primary/violet/sm.
- windows/UsersWindow/billing/PeriodHoursCard.tsx - grant CTA -> primary/violet/sm.
- windows/UsersWindow/billing/TerosProviderConfigModal.tsx - create -> primary/violet/sm + loading.
EXCLUDED (stay in Tamagui):
- period-revoke-* and teros-config-delete-* (tone=danger, destructive) + ConfirmDialog confirm/cancel buttons - destructive class, stay until the DS defines a destructive tone.
- formPrimitives.tsx local Button stays for the danger buttons (and Chip/FieldLabel/etc. are not buttons at all).
- windows/UsersWindow/detail/FacturacionTab.tsx

### components/chat/ - MIGRATED 2026-10-06 (CTAs only)
MIGRATED 2026-10-06:
- components/chat/ChatView.tsx - load-more (conversation.loadEarlierMessages) -> secondary/violet/sm, label-only, theme={mcaTheme}. The only real CTA with a label in the chat group.
EXCLUDED (stay in Tamagui):
- bubbles/AudioBubble.tsx, VideoBubble.tsx, VoiceBubble.tsx - media play controls (icon-only, custom geometry 36-56px, custom radii, conditional indigoGlow backgrounds). Icon-only media class, not CTAs.
- bubbles/HtmlBubble.tsx - chromeless icon-only open-viewer/open-markdown buttons.
- AudioBubble retry (chromeless amber) and VoiceBubble menu (chromeless circular) - chromeless utility class.
- ChatView voice-start (red 26% bg / red 66% border) - semantic red like StopButton, stays off-palette.
- HardCancelModal.tsx - deny + confirm both theme=red - destructive/safety class.
- PrePublishWarningDialog.tsx - cancel + confirm both theme=orange - semantic warning tone (same principle as DS status colors; do not improvise).
- StopButton.tsx - already excluded (red safety signal).

## Notes

- Census method: grep for Tamagui Button JSX across src/ and app/ (2026-10-06). Re-run the census before starting Phase 2 - the codebase moves.
- Migration order proposal: (1) auth screens (login/signup - high visibility, simple buttons), (2) modal primary CTAs (billing, provider setup), (3) window toolbars (icon-only utility), (4) chat surfaces (last - highest traffic, needs the most care).
- Progress 2026-10-06: groups 1 (auth), 2 (billing CTAs), 2b (UsersWindow billing forms) and 4 (chat CTAs) are done. Group 3 (window toolbars) is PENDING and needs a design call with Pablo first: current toolbars are small ghost/circular chromeless icon-only buttons, while the TerosButton icon-only engine renders a violet pill with wandering blur - migrating a whole toolbar changes the feel radically. Validate the already-migrated CTAs first, then decide toolbar treatment (dedicated toolbar variant in the DS, or keep toolbars chromeless by design).
- The feature flag that gated this migration was removed on 2026-10-06 (Pablo: a feature flag for a button makes no sense). TerosButton is THE button - every migration renders it directly, no fallbacks, no overrides.
- The token bridge (teros-tokens.ts) is the single source of truth for colors/geometry - never hardcode hex in migrated buttons.
- Regenerate the bridge after DS token changes: node scripts/regen-teros-tokens.mjs (from monorepo root).
