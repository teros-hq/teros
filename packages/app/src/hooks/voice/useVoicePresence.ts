/**
 * useVoicePresence — the global voice door (F5e, ui-evolution §3.7 extension)
 *
 * Voice sessions can now be started from OUTSIDE a chat window (navbar,
 * anywhere). This hook owns the start logic that used to live only inside
 * ChatView.handleStartVoice:
 *
 *   1. Resolve the agent — explicit agentId, or the first agent of the
 *      active workspace (navbarStore cache — the same list the navbar shows).
 *   2. Resolve the conversation channel — the voice loop REQUIRES a
 *      chatChannelId (or a stored session to resume): voice lives in the
 *      conversation channel (F0, REQ-2). If the agent has a stored session,
 *      the backend resumes it; otherwise we create a fresh channel.
 *   3. startSession(agentId, undefined, channelId).
 *
 * DEFERRED DECISIONS (NOT designed here — see docs/specs/voice-mode/
 * 2026-10-f5e-open-questions.md): whether opening voice without a
 * conversation should create a new conversation, reuse the last active one,
 * or have dedicated voice conversations. Today: a fresh channel per start
 * (the same behavior ChatView had) — Pablo decides later with the
 * experience in his hands.
 *
 * The stop side is the context's own stopSession — one door, no duplication.
 */

import { useCallback, useRef } from 'react';
import type { VoiceMode } from '@teros/shared';
import { useVoiceSession } from '../../contexts/VoiceSessionContext';
import { useNavbarStore } from '../../store/navbarStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useFeatureFlagsStore, getResolvedFlag } from '../../store/featureFlagsStore';
import { getTerosClient } from '../../services/terosClientSingleton';
import { STORAGE_KEYS, storage } from '../../services/storage';

/** Start a voice session for an agent (or the workspace's first agent). */
export function useVoicePresence() {
  const session = useVoiceSession();
  const startingRef = useRef(false); // AF-3: guard against rapid double-tap

  const startVoiceFor = useCallback(
    async (agentId?: string, opts?: { initialMode?: VoiceMode }) => {
      if (startingRef.current) return;
      if (!getResolvedFlag<boolean>(useFeatureFlagsStore.getState(), 'voice.enabled')) return;

      // Already talking to this agent — nothing to start (the orb is alive).
      if (agentId && session.activeAgentId === agentId && session.presence !== 'off') return;

      startingRef.current = true;
      try {
        // 1. Resolve the agent — explicit, or the first one of the active
        //    workspace (the navbar's own list — no new fetch, no flicker).
        let resolvedAgentId = agentId;
        if (!resolvedAgentId) {
          const { agents } = useNavbarStore.getState();
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
          // Pablo (31-10, decision 3): the voice of the presence is ALWAYS the
          // super-agent (global scope — no workspaceId). A workspace agent is
          // only the fallback for workspaces that have no super-agent cached.
          const candidate =
            agents.find((a) => !a.workspaceId) ??
            agents.find((a) => a.workspaceId && a.workspaceId === workspaceId);
          if (!candidate) {
            session.setError({
              code: 'bad_request',
              message: 'No agent available for voice — create an agent first.',
            });
            return;
          }
          resolvedAgentId = candidate.agentId;
        }

        // 2. Resolve the conversation channel. The voice loop requires one
        //    (F0/REQ-2 — voice lives in the conversation channel). A stored
        //    session for THIS agent is resumed by the backend (startSession
        //    reads STORAGE_KEYS.VOICE_SESSION); otherwise create a channel.
        //    This mirrors ChatView.handleStartVoice exactly — one behavior,
        //    two doors.
        let chatChannelId: string | undefined;
        const stored = await storage.get<{ agentId: string; channelId: string; savedAt: number }>(
          STORAGE_KEYS.VOICE_SESSION,
        );
        if (stored && stored.agentId === resolvedAgentId) {
          chatChannelId = stored.channelId; // resume — the backend owns the check
        } else {
          const client = getTerosClient();
          const workspaceId = useWorkspaceStore.getState().activeWorkspaceId ?? undefined;
          const result = await client.channel.create({
            agentId: resolvedAgentId,
            workspaceId,
          });
          chatChannelId = result.channelId;
        }

        // 3. Start.
        await session.startSession(resolvedAgentId, undefined, chatChannelId, opts?.initialMode);
      } catch (err) {
        console.error('[useVoicePresence] startVoiceFor failed:', err);
        const message = err instanceof Error ? err.message : 'Failed to start voice session';
        session.setError({ code: 'unknown', message });
      } finally {
        startingRef.current = false;
      }
    },
    [session],
  );

  const stopVoice = useCallback(() => {
    session.stopSession();
  }, [session]);

  return { startVoiceFor, stopVoice };
}
