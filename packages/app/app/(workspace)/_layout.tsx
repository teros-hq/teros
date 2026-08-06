/**
 * Workspace Layout - Tiling Window Manager
 *
 * Wraps all workspace routes. Renders the TilingLayout and handles:
 * - Authentication guard (reads from authStore, never from storage directly)
 * - Auto-save of workspace state
 * - Global listeners (channel status, typing)
 * - URL sync with active window
 *
 * Child routes (chat/[channelId], apps, etc.) only trigger window open/focus,
 * they don't render content themselves.
 */

import { Slot, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { AppSpinner } from '../../src/components/ui/AppSpinner';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { YStack } from 'tamagui';
import { AccessGate } from '../../src/components/AccessGate';
import { BillingWarningBanner } from '../../src/components/billing/BillingWarningBanner';
import { ImpersonationBanner } from '../../src/components/ImpersonationBanner';
import { Navbar } from '../../src/components/Navbar';
import { WhatsNewModal } from '../../src/components/WhatsNewModal';
import { useWhatsNewModal } from '../../src/hooks/useWhatsNewModal';
import { useBillingRealtimeSync } from '../../src/hooks/billing/useBillingRealtimeSync';
import { shouldRedirectToOnboarding } from '../../src/lib/onboarding-redirect';
import { TilingLayout } from '../../src/components/workspace/TilingLayout';
import { useColors } from '../../src/components/mca/primitives/useColors';
import { useUrlSync } from '../../src/hooks';
import { useAuthStore } from '../../src/store/authStore';
import { useChatStore } from '../../src/store/chatStore';
import { useFeatureFlagsStore } from '../../src/store/featureFlagsStore';
import { useNavbarStore } from '../../src/store/navbarStore';
import { useTilingStore } from '../../src/store/tilingStore';
import { VoiceSessionProvider } from '../../src/contexts/VoiceSessionContext';
import { getTerosClient } from '../../src/services/terosClientSingleton';
import { useWorkspaceReady as useWorkspaceReadyHook, WorkspaceContext } from './workspaceContext';

export { useWorkspaceReadyHook as useWorkspaceReady };

const AUTO_SAVE_DELAY = 1000;

export default function WorkspaceLayout() {
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);

  const router = useRouter();
  const client = getTerosClient();
  const insets = useSafeAreaInsets();
  const c = useColors();

  // Auth state — single source of truth, no direct storage reads here
  const { user, isHydrated, isProfileSynced, impersonation, logout } = useAuthStore();

  const desktops = useTilingStore((state) => state.desktops);
  const windows = useTilingStore((state) => state.windows);
  const persistToStorage = useTilingStore((state) => state.persistToStorage);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  useUrlSync(workspaceLoaded);

  // Billing UX realtime (FASE 6): feeds the 80% warning banner + admin badge.
  useBillingRealtimeSync();

  // "What's New" changelog modal — auto-shows on load if there are unseen entries
  const whatsNew = useWhatsNewModal();

  useEffect(() => {
    if (!isHydrated) return;

    if (!user) {
      router.replace('/(auth)/login');
      return;
    }

    // Only show terms screen if user already has platform access
    if (user.accessGranted && !user.termsAcceptedAt) {
      router.replace('/(auth)/login/welcome');
      return;
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
      router.replace('/(auth)/login/onboarding');
      return;
    }
  }, [isHydrated, isProfileSynced, impersonation, user]);

  // Mark workspace as loaded on mount (state is restored by workspaceStore.setActiveWorkspace)
  useEffect(() => {
    setWorkspaceLoaded(true);
  }, []);

  // Auto-save workspace layout to PersistedDriver (debounced)
  useEffect(() => {
    if (isFirstRender.current || !workspaceLoaded) {
      isFirstRender.current = false;
      return;
    }

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);

    saveTimeoutRef.current = setTimeout(() => {
      persistToStorage();
    }, AUTO_SAVE_DELAY);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [desktops, windows, workspaceLoaded]);

  // Global listeners for channel status and typing events
  useEffect(() => {
    const handleChannelListStatus = (data: any) => {
      const { channelId, action, channel } = data;
      if (!channelId) return;

      if (action === 'updated' && channel) {
        const updates: any = {};
        if (channel.title !== undefined) updates.title = channel.title;
        if (channel.isTyping !== undefined) updates.isTyping = channel.isTyping;
        if (channel.externalActionRequested !== undefined)
          updates.externalActionRequested = channel.externalActionRequested;

        if (Object.keys(updates).length > 0) {
          useChatStore.getState().updateChannel(channelId, updates);
        }
      } else if (action === 'created' && channel) {
        useChatStore.getState().setChannel({
          channelId,
          title: channel.title || 'New chat',
          agentId: channel.agentId || '',
          agentName: '',
          agentAvatarUrl: null,
          isTyping: false,
          isRenaming: false,
          isAutonaming: false,
          lastMessageAt: channel.createdAt || null,
          createdAt: channel.createdAt || new Date().toISOString(),
          updatedAt: channel.updatedAt || new Date().toISOString(),
          externalActionRequested: false,
        });
      }
    };

    const handleTyping = (data: any) => {
      if (data.channelId) {
        useChatStore.getState().setTyping(data.channelId, data.isTyping ?? false);
      }
    };

    client.on('channel_list_status', handleChannelListStatus);
    client.on('typing', handleTyping);

    return () => {
      client.off('channel_list_status', handleChannelListStatus);
      client.off('typing', handleTyping);
    };
  }, [client]);

  const handleLogout = async () => {
    useFeatureFlagsStore.getState().clear();
    await logout();
    client.setSessionToken('');
    client.disconnect();
    useNavbarStore.getState().reset();
    router.replace('/(auth)/login');
  };

  // Show spinner while hydrating. If there's no user, the useEffect above will
  // redirect to login — show spinner meanwhile.
  if (!isHydrated || !user) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage}>
        <AppSpinner size="lg" variant="brand" />
      </YStack>
    );
  }

  return (
    <AccessGate client={client}>
      <WorkspaceContext.Provider value={{ isReady: workspaceLoaded }}>
        <VoiceSessionProvider>
          <ImpersonationBanner />
          <BillingWarningBanner />
          <Navbar userName={user.name} userRole={user.role} onLogout={handleLogout} onWhatsNew={whatsNew.showWhatsNew}>
            {/* c.bgPage: this color shows through the bottom safe-zone band
                (paddingBottom) and matches the root background of both
                MobileTilingLayout and TilingLayout, so the band
                reads as a continuation of the canvas, not a distinct strip. */}
            <YStack flex={1} backgroundColor={c.bgPage} paddingBottom={insets.bottom}>
              <TilingLayout />
              <Slot />
            </YStack>
          </Navbar>
          {/* "What's New" changelog modal — overlay, not part of the tiling system */}
          {whatsNew.isModalVisible && whatsNew.modalEntries.length > 0 && (
            <WhatsNewModal
              entries={whatsNew.modalEntries}
              onDismiss={whatsNew.handleDismiss}
              isManualReopen={whatsNew.isManualReopen}
            />
          )}
        </VoiceSessionProvider>
      </WorkspaceContext.Provider>
    </AccessGate>
  );
}
