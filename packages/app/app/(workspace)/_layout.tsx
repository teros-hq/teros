/**
 * Workspace Layout - Tiling Window Manager
 *
 * Wraps all workspace routes. Renders the TilingLayout and handles:
 * - Authentication guard (reads from authStore, never from storage directly)
 * - Auto-save of workspace state
 * - Global listeners (channel status, typing)
 *
 * The URL is a session URL: the root (/) resolves the active workspace and
 * replaces to /workspace/[workspaceId], which is the real shell route (the
 * desktop segment /desktop/[n] mirrors the active desktop). DesktopUrlSync
 * (mounted here) is the single state→URL writer; window state stays owned by
 * the tilingStore — no per-window URL sync ever comes back.
 */

import { Slot, useRouter } from "expo-router"
import React, { useEffect, useRef } from "react"
import { AppSpinner } from "../../src/components/ui/AppSpinner"
import { useWindowDimensions } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { YStack } from "tamagui"
import { AccessGate } from "../../src/components/AccessGate"
import { AutomateQuotaBanner } from "../../src/components/billing/AutomateQuotaBanner"
import { BillingWarningBanner } from "../../src/components/billing/BillingWarningBanner"
import { ImpersonationBanner } from "../../src/components/ImpersonationBanner"
import { NavbarShell } from "../../src/components/navbarV2/NavbarShell"
import { WhatsNewModal } from "../../src/components/WhatsNewModal"
import { TerminalNeedsWatcher } from "../../src/components/needsYou/TerminalNeedsWatcher"
import { TerminalAttention } from "../../src/windows/TerminalWindow/TerminalAttention"
import { FloatingTerminalLayer } from "../../src/windows/TerminalWindow/floating"
import { useWhatsNewModal } from "../../src/hooks/useWhatsNewModal"
import { useBillingRealtimeSync } from "../../src/hooks/billing/useBillingRealtimeSync"
import { useUiSync } from "../../src/services/uiSync"
import { installChatNotifications } from "../../src/services/chatNotifications"
import { shouldRedirectToOnboarding } from "../../src/lib/onboarding-redirect"
import { captureInviteParams } from "../../src/lib/inviteParams"
import { PendingInvitationsBanner } from "../../src/components/workspace/PendingInvitations"
import { DesktopUrlSync } from "../../src/components/workspace/DesktopUrlSync"
import { TilingLayout } from "../../src/components/workspace/TilingLayout"
import { useLayoutRestoreGate } from "../../src/components/workspace/useLayoutRestoreGate"
import { useColors } from "../../src/components/mca/primitives/useColors"
import { useAuthStore } from "../../src/store/authStore"
import { useChatStore } from "../../src/store/chatStore"
import { useFeatureFlagsStore } from "../../src/store/featureFlagsStore"
import { useNavbarStore } from "../../src/store/navbarStore"
import { useTilingStore } from "../../src/store/tilingStore"
import { useWorkspaceStore } from "../../src/store/workspaceStore"
import { isInWorkspace } from "@teros/shared"
import { VoiceSessionProvider } from "../../src/contexts/VoiceSessionContext"
import { VoiceOrbOverlay } from "../../src/components/voice/VoiceOrbOverlay"
import { getTerosClient } from "../../src/services/terosClientSingleton"
import { useNavigation, usePreventRemove } from "@react-navigation/native"
import { useRecordingSessionStore, destroyRecordingSession } from "../../src/store/recordingSessionStore"
import { useWorkspaceReady as useWorkspaceReadyHook, WorkspaceContext } from "./workspaceContext"

export { useWorkspaceReadyHook as useWorkspaceReady }

const AUTO_SAVE_DELAY = 1000

export default function WorkspaceLayout() {
  // Layout-restore gate (isReady for the shell routes): derived from the
  // tilingStore's restore GENERATION so it re-arms on every restore — the
  // layoutRestored boolean latches true on the FIRST restore and would stay
  // true across workspace switches, letting consumers judge a stale layout
  // mid-switch. See useLayoutRestoreGate.
  const workspaceLoaded = useLayoutRestoreGate()

  const router = useRouter()
  const client = getTerosClient()
  const insets = useSafeAreaInsets()
  // The phone shell (MobileTilingLayout) owns the bottom safe zone itself.
  const isPhone = useWindowDimensions().width < 768
  const c = useColors()

  // Auth state — single source of truth, no direct storage reads here
  const { user, isAuthenticated, isHydrated, isProfileSynced, impersonation, logout } =
    useAuthStore()

  // MUW-14 Fase 2: capture ?invite_email=&invite_token= BEFORE the auth guard
  // redirects to login (which drops query params). Runs on the first mount —
  // the layout renders before its children, so this wins the race against the
  // guard's useEffect. The stash survives the login round-trip in
  // sessionStorage; the RootResolver consumes it after the invite is resolved.
  useEffect(() => {
    captureInviteParams()
  }, [])

  const desktops = useTilingStore((state) => state.desktops)
  const windows = useTilingStore((state) => state.windows)
  const persistToStorage = useTilingStore((state) => state.persistToStorage)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRender = useRef(true)

  // Billing UX realtime (FASE 6): feeds the 80% warning banner + admin badge.
  useBillingRealtimeSync()

  // UI State live report + command executor (spec 20261022_ui-state-mca.md):
  // reports the tiling layout to the backend on every meaningful change and
  // applies ui_command events (open/close/focus windows, switch desktop).
  useUiSync()

  // "What's New" changelog modal — auto-shows on load if there are unseen entries
  const whatsNew = useWhatsNewModal()

  // ── Recording guard: prevent accidental navigation while recording ────
  // Reads from the module-level recording session store (survives Fast Refresh).
  // On web, the browser back button triggers popstate → react-navigation
  // dispatches a GO_BACK action → beforeRemove fires → we can prevent it.
  // If the user confirms, we destroy the recording session and let them leave.
  const isRecordingActive = useRecordingSessionStore((s) => s.recordingState === 'recording' || s.engineActive)

  const navigation = useNavigation()

  usePreventRemove(isRecordingActive, ({ data }) => {
    // On web, window.confirm is the standard pattern for beforeRemove
    // (react-navigation docs recommend it for web).
    if (typeof window !== 'undefined') {
      const shouldLeave = window.confirm(
        'Estás grabando un audio — ¿salir y descartarlo?'
      )
      if (shouldLeave) {
        destroyRecordingSession()
        // Re-dispatch the original action so navigation proceeds.
        // The store is now clean, so the guard won't fire again.
        navigation.dispatch(data.action)
      }
    }
  })

  useEffect(() => {
    if (!isHydrated) return

    // No user OR no valid session token. The second check matters on web:
    // hydrate() restores the user profile from localStorage but the token may
    // be gone (in-memory only, Req 6.6.1) — without it the app would render a
    // fully disconnected workspace ("zombie" UI, no errors anywhere). hydrate()
    // only finishes after attempting the cookie-based session restore, so
    // redirecting here never races a restore still in flight.
    if (!user || !isAuthenticated) {
      router.replace("/(auth)/login")
      return
    }

    // Only show terms screen if user already has platform access
    if (user.accessGranted && !user.termsAcceptedAt) {
      router.replace("/(auth)/login/welcome")
      return
    }

    // Onboarding gate (TER-596 I2): users who accepted terms but haven't finished
    // onboarding go to the wizard (which now includes the mandatory plan + checkout).
    // Wait for the backend profile sync first — onboardingCompletedAt may be absent
    // from localStorage yet set on the server. Skip while impersonating (the guard
    // lives in shouldRedirectToOnboarding; see its docstring). Review finding M4.
    if (
      shouldRedirectToOnboarding({
        isProfileSynced,
        isImpersonating: !!impersonation?.isImpersonating,
        accessGranted: user.accessGranted,
        termsAcceptedAt: user.termsAcceptedAt,
        onboardingCompletedAt: user.onboardingCompletedAt,
      })
    ) {
      router.replace("/(auth)/login/onboarding")
      return
    }
  }, [isHydrated, isAuthenticated, isProfileSynced, impersonation, user])

  // Auto-save workspace layout to PersistedDriver (debounced)
  useEffect(() => {
    if (isFirstRender.current || !workspaceLoaded) {
      isFirstRender.current = false
      return
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)

    saveTimeoutRef.current = setTimeout(() => {
      persistToStorage()
    }, AUTO_SAVE_DELAY)

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    }
  }, [desktops, windows, workspaceLoaded])

  // Unread badges of chat windows — one store-level watcher (TABH-REQ-5), so
  // hibernated tabs still raise theirs.
  useEffect(() => installChatNotifications(), [])

  // Global listeners for channel status and typing events
  useEffect(() => {
    const handleChannelListStatus = (data: any) => {
      const { channelId, action, channel } = data
      if (!channelId) return

      if (action === "updated" && channel) {
        const updates: any = {}
        if (channel.title !== undefined) updates.title = channel.title
        if (channel.isTyping !== undefined) updates.isTyping = channel.isTyping
        if (channel.externalActionRequested !== undefined)
          updates.externalActionRequested = channel.externalActionRequested

        if (Object.keys(updates).length > 0) {
          useChatStore.getState().updateChannel(channelId, updates)
        }
      } else if (
        action === "created" &&
        channel &&
        // Sent to every session of the user: keep only this workspace's (CHAN-REQ-12).
        isInWorkspace(channel, useWorkspaceStore.getState().activeWorkspaceId)
      ) {
        useChatStore.getState().setChannel({
          channelId,
          title: channel.title || "New chat",
          agentId: channel.agentId || "",
          agentName: "",
          agentAvatarUrl: null,
          isTyping: false,
          isRenaming: false,
          isAutonaming: false,
          lastMessageAt: channel.createdAt || null,
          createdAt: channel.createdAt || new Date().toISOString(),
          updatedAt: channel.updatedAt || new Date().toISOString(),
          externalActionRequested: false,
        })
      }
    }

    const handleTyping = (data: any) => {
      if (data.channelId) {
        useChatStore.getState().setTyping(data.channelId, data.isTyping ?? false)
      }
    }

    client.on("channel_list_status", handleChannelListStatus)
    client.on("typing", handleTyping)

    return () => {
      client.off("channel_list_status", handleChannelListStatus)
      client.off("typing", handleTyping)
    }
  }, [client])

  const handleLogout = async () => {
    useFeatureFlagsStore.getState().clear()
    await logout()
    client.setSessionToken("")
    client.disconnect()
    useNavbarStore.getState().reset()
    router.replace("/(auth)/login")
  }

  // Show spinner while hydrating. If there's no user, the useEffect above will
  // redirect to login — show spinner meanwhile.
  if (!isHydrated || !user) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgFrame}>
        <AppSpinner size="lg" variant="brand" />
      </YStack>
    )
  }

  return (
    <AccessGate client={client}>
      <WorkspaceContext.Provider value={{ isReady: workspaceLoaded }}>
        <VoiceSessionProvider>
          <ImpersonationBanner />
          <BillingWarningBanner />
          <AutomateQuotaBanner />
          <PendingInvitationsBanner />
          <NavbarShell
            userName={user.name}
            userRole={user.role}
            onLogout={handleLogout}
            onWhatsNew={whatsNew.showWhatsNew}
          >
            {/* c.bgPage: this color shows through the bottom safe-zone band
                (paddingBottom) and matches the root background of both
                MobileTilingLayout and TilingLayout, so the band
                reads as a continuation of the canvas, not a distinct strip. */}
            <YStack
              flex={1}
              backgroundColor={c.bgFrame}
              paddingBottom={isPhone ? 0 : insets.bottom}
            >
              <DesktopUrlSync workspaceLoaded={workspaceLoaded} />
              {/* Coding agents waiting in terminal sessions → toast + Terminal badge */}
              <TerminalAttention />
              {/* …and in every workspace, for the general notices (navbar banner, Pending Approvals, Home) */}
              <TerminalNeedsWatcher />
              <TilingLayout />
              <Slot />
            </YStack>
          </NavbarShell>
          {/* "What's New" changelog modal — overlay, not part of the tiling system */}
          {whatsNew.isModalVisible && whatsNew.modalEntries.length > 0 && (
            <WhatsNewModal
              entries={whatsNew.modalEntries}
              onDismiss={whatsNew.handleDismiss}
              isManualReopen={whatsNew.isManualReopen}
            />
          )}
          {/* F5e: the persistent floating voice orb — while a voice session
              lives, the orb floats over the WHOLE app (draggable, closable).
              Inside the provider: it reads the session context. Renders
              nothing while there is no session (presence off + flag off). */}
          {/* Floating terminals (dragged out of a Terminal window's crew rail):
              a layer above the tiling system, not part of it. */}
          <FloatingTerminalLayer />
          <VoiceOrbOverlay />
        </VoiceSessionProvider>
      </WorkspaceContext.Provider>
    </AccessGate>
  )
}
