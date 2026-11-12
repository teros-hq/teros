/**
 * Voice Loop Frames — local backend mirror of the v2 frame contract
 *
 * Voice Mode v2 — F1a. These types mirror the canonical contract in
 * `packages/shared/src/voice-frames.ts` (Iria, commit 769783248) — the frames
 * the native voice loop emits/consumes over the `/voice` WebSocket.
 *
 * Why a local mirror instead of importing `@teros/shared`: this worktree shares
 * the monorepo root's node_modules, whose `@teros/shared` symlink points at the
 * MAIN checkout (branch `dev`), which does not have `voice-frames.ts` yet. Once
 * `feat/voice-mode-v2` merges to dev (or the worktree gets its own node_modules),
 * switch these imports to the shared contract.
 *
 * @todo nira - 2026-10-02: replace this mirror with `import from '@teros/shared'`
 * when the shared package resolves voice-frames.ts in this environment — keep
 * the shapes identical to the canonical contract until then.
 */

// ============================================================================
// AXES (mirror of voice-frames.ts)
// ============================================================================

/** Presence axis — is there a voice session at all? */
export type VoicePresence = 'off' | 'connecting' | 'on' | 'error';

/** Mode axis — how the agent responds to what it hears (REQ-6). */
export type VoiceMode = 'available' | 'passive' | 'conversation';
export const VOICE_MODES: readonly VoiceMode[] = ['available', 'passive', 'conversation'] as const;

/** Activity axis — what is happening inside an active session. */
export type VoiceActivity =
  | 'idle'
  | 'hearing'
  | 'thinking'
  | 'speaking'
  | 'waiting_worker'
  | 'reconnecting';

// ============================================================================
// ERRORS (REQ-11 catalog — the subset the native loop emits)
// ============================================================================

export type VoiceErrorCode =
  | 'auth'
  | 'flag_disabled'
  | 'timeout'
  | 'workspace_unresolved'
  | 'server_error'
  | 'bad_request'
  | 'channel_required'
  | 'channel_unavailable'
  | 'stt_error'
  | 'tts_error'
  | 'unknown';

// ============================================================================
// SERVER → CLIENT FRAMES (mirror of VoiceServerFrame — native-loop subset)
// ============================================================================

export type VoiceLoopServerFrame =
  | { type: 'voice_channel'; channelId: string; isResuming?: boolean; historicTranscripts?: VoiceLoopHistoricTranscript[] }
  | { type: 'transcript'; text: string; isUser: boolean; partial?: boolean; overheard?: boolean }
  | { type: 'agent_response_delta'; text: string }
  | { type: 'tts_chunk'; audio_base_64: string }
  // PoC 2026-10-31: the tts_chunk frames since the previous segment form one
  // decodable audio segment; `alignment` is its character timing (or null).
  | { type: 'tts_segment'; alignment: { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] } | null }
  // PoC 2026-10-31: metadata written on a thread message (e.g. voice.spokenChars
  // after a barge-in) — the client patches its chat store live.
  | { type: 'message_meta'; messageId: string; metadata: Record<string, unknown> }
  | { type: 'speaking_started'; messageId?: string | null }
  | { type: 'speaking_ended' }
  | { type: 'activity'; activity: VoiceActivity }
  | { type: 'mode_changed'; mode: VoiceMode; source: 'voice' | 'ui' | 'system' }
  /** PoC 2026-10-31: the dialogue window opened for `openMs` ms (0 = closed) — the UI shows a transient "Conversando". */
  | { type: 'dialogue_window'; openMs: number }
  | {
      type: 'channel_event';
      eventType: 'channel_started' | 'channel_finished' | 'channel_permission' | 'channel_resolved';
      observedChannelId?: string;
      observedChannelName?: string;
      toolName?: string;
      resolution?: 'granted' | 'denied';
    }
  | { type: 'tool_call'; toolName?: string; message?: string }
  | { type: 'tool_result'; text?: string }
  | { type: 'tool_error'; error?: string }
  | { type: 'interrupt'; playbackPositionMs: number }
  | { type: 'error'; code: VoiceErrorCode; message: string }
  | { type: 'pong'; event_id?: string };

export interface VoiceLoopHistoricTranscript {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  type?: string;
}

// ============================================================================
// CLIENT → SERVER FRAMES (mirror of VoiceClientFrame)
// ============================================================================

export type VoiceLoopClientFrame =
  | { type: 'set_mode'; mode: VoiceMode }
  | { type: 'user_audio_chunk'; audio_base_64: string }
  | { type: 'interrupt'; playbackPositionMs: number }
  | { type: 'playback_ended' } // F5h: client's TTS queue drained — real playback end (not send-end)
  | { type: 'playback_started' } // PoC trace: the client's first TTS buffer started sounding
  | { type: 'playback_position'; positionMs: number } // PoC: the client's real playback position at the cut
  | { type: 'ping'; event_id?: string }
  | { type: 'pong'; event_id?: string };

/**
 * Normalize an unknown inbound client frame. Returns null for non-JSON or
 * malformed payloads (bad_request handling stays at the call site).
 */
export function parseVoiceLoopClientFrame(raw: string): VoiceLoopClientFrame | null {
  try {
    const msg = JSON.parse(raw);
    if (msg && typeof msg.type === 'string') return msg as VoiceLoopClientFrame;
    return null;
  } catch {
    return null;
  }
}
