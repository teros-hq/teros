/**
 * Workspace Root Resolver — ruta raíz (/)
 *
 * The root NEVER renders the shell: it resolves the session URL
 * (/workspace/[activeWorkspaceId]) and replaces to it. While resolving it
 * shows a brand splash — the tiling layout must never flash on "/".
 *
 * Resolution order:
 * 1. Wait for auth hydration (the group layout's auth guard redirects to
 *    login/onboarding if needed — we just wait here).
 * 2. Wait for the workspaceStore hydration (hydrateActiveWorkspace, kicked
 *    off by the Navbar on load: sessionStorage → localStorage fallback).
 * 3. activeWorkspaceId → /workspace/[id].
 * 4. No active workspace (fresh user, cleared storage): ask the backend for
 *    the user's workspaces and default to the private one (same rule as the
 *    Navbar).
 *
 * Failure is a screen, not silence: if the request fails (backend down, 401,
 * network) or the user has no workspaces at all, the resolver renders the
 * editorial error screen (EditorialScreen — the same card as the pretty 404)
 * with a Retry action that re-runs the resolution. A dead blank page tells the
 * user nothing about whether the app is broken or loading. The two failures
 * get distinct copy: a failed request may recover on retry; an account with
 * no workspaces will not (retry stays anyway — harmless, and a workspace
 * created in the meantime does resolve).
 *
 * No layout logic lives here (moved to WorkspaceShellInit on the shell route).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { YStack } from 'tamagui';
import { useTranslation } from 'react-i18next';
import { AppSpinner } from '../../src/components/ui/AppSpinner';
import { EditorialScreen } from '../../src/components/ui/EditorialScreen';
import { useColors } from '../../src/components/mca/primitives/useColors';
import { useAuthStore } from '../../src/store/authStore';
import { useWorkspaceStore } from '../../src/store/workspaceStore';
import { getTerosClient } from '../../src/services/terosClientSingleton';
import {
  peekInviteParams,
  consumeInviteParams,
  type InviteParams,
} from '../../src/lib/inviteParams';
import { PendingInvitationsScreen } from '../../src/components/workspace/PendingInvitations';

/** Why the session URL could not be resolved — drives the error copy. */
type ResolutionFailure = 'request-failed' | 'no-workspaces';

export default function WorkspaceIndex() {
  const router = useRouter();
  const c = useColors();
  const { t } = useTranslation();
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const [failure, setFailure] = useState<ResolutionFailure | null>(null);
  const resolving = useRef(false);
  /** Bumped by Retry so the effect re-runs the resolution (see handleRetry). */
  const [retryCount, setRetryCount] = useState(0);

  // MUW-14 Fase 2: the email CTA stashed ?invite_email=&invite_token= (the
  // (workspace) layout captured them before the auth guard could drop them).
  // While a stashed invite exists, the root renders the Accept/Decline screen
  // INSTEAD of resolving — the invitee decides before entering any workspace.
  // consumeInviteParams() (one-shot) clears the stash once resolved, and the
  // normal resolution re-runs via inviteDoneTick.
  const [invite, setInvite] = useState<InviteParams | null>(null);
  const [inviteDoneTick, setInviteDoneTick] = useState(0);

  useEffect(() => {
    // Wait for auth hydration: without a session the layout's guard redirects
    // to login (params already stashed); when the user comes back the stash
    // is still there and the screen shows.
    if (!isHydrated) return;
    setInvite(peekInviteParams());
  }, [isHydrated, inviteDoneTick]);

  useEffect(() => {
    if (!isHydrated || resolving.current) return;

    // Fast path: an active workspace is already known (storage hydration or
    // an earlier session) — resolve immediately.
    if (activeWorkspaceId) {
      resolving.current = true;
      router.replace(`/workspace/${activeWorkspaceId}`);
      return;
    }

    // Slow path: no active workspace in storage. Ask the backend for the
    // user's workspaces and default to the private one (Navbar's rule).
    resolving.current = true;
    (async () => {
      try {
        // Race guard: the Navbar's hydrateActiveWorkspace (sessionStorage →
        // localStorage) may land while we wait — if so, honor it: the user's
        // real active workspace (possibly a team one) beats the private
        // fallback. Re-checked before the request AND after it resolves.
        const raced = useWorkspaceStore.getState().activeWorkspaceId;
        if (raced) {
          router.replace(`/workspace/${raced}`);
          return;
        }

        const client = getTerosClient();
        const { workspaces } = await client.workspace.listWorkspaces();

        const racedLate = useWorkspaceStore.getState().activeWorkspaceId;
        if (racedLate) {
          router.replace(`/workspace/${racedLate}`);
          return;
        }

        const privateWs = workspaces.find((ws: any) => ws.type === 'private');
        const fallback = privateWs ?? workspaces[0];
        if (!fallback) {
          console.warn(
            '[RootResolver] listWorkspaces returned no workspaces — cannot resolve session URL',
          );
          setFailure('no-workspaces');
          return;
        }
        setActiveWorkspace(fallback.workspaceId);
        router.replace(`/workspace/${fallback.workspaceId}`);
      } catch (err) {
        console.error('[RootResolver] listWorkspaces failed — cannot resolve session URL:', err);
        setFailure('request-failed');
      }
    })();
  }, [isHydrated, activeWorkspaceId, retryCount, router, setActiveWorkspace]);

  // Retry: re-arm the one-attempt guard, drop the failure state (the splash
  // shows while resolving again) and bump the token so the effect re-runs.
  // If the backend recovered (or storage hydration landed in the meantime),
  // the resolution proceeds normally — fast path included; if not, the
  // screen comes back up.
  const handleRetry = () => {
    resolving.current = false;
    setFailure(null);
    setRetryCount((n) => n + 1);
  };

  // MUW-14 Fase 2: the invite screen replaces the resolver until the invite
  // is resolved (accepted, declined, or invalid — all end-states call
  // handleInviteDone). Placed AFTER all hooks (no conditional returns above).
  if (invite) {
    const handleInviteDone = () => {
      consumeInviteParams();
      setInvite(null);
      // Re-run the normal resolution (the peek effect re-runs on the tick and
      // finds the now-empty stash; the resolver effect also re-runs).
      setInviteDoneTick((n) => n + 1);
    };
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage}>
        <PendingInvitationsScreen
          inviteEmail={invite.inviteEmail}
          inviteToken={invite.inviteToken}
          onDone={handleInviteDone}
        />
      </YStack>
    );
  }

  // Pure resolver: splash while resolving, editorial error screen on failure —
  // never the tiling shell, never a silent blank.
  return (
    <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor={c.bgPage}>
      {failure ? (
        <EditorialScreen
          title={t(
            failure === 'no-workspaces'
              ? 'rootResolver.titleNoWorkspaces'
              : 'rootResolver.titleFailed',
          )}
          description={t(
            failure === 'no-workspaces'
              ? 'rootResolver.descriptionNoWorkspaces'
              : 'rootResolver.descriptionFailed',
          )}
          actionLabel={t('rootResolver.retry')}
          onAction={handleRetry}
        />
      ) : (
        <AppSpinner size="lg" variant="brand" />
      )}
    </YStack>
  );
}
