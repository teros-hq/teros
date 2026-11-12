/**
 * Voice Mode v2 — Frame contract (WS /voice)
 *
 * The single source of truth for the voice session state model (3 orthogonal
 * axes) and the frames that flow over the voice WebSocket. Shared by the
 * backend voice loop (F1/F2) and the frontend (F3a — Iria).
 *
 * Model (spec v1.1.0 §REQ-6, ui-evolution.md §1.2):
 *   presence × mode × activity
 *     - presence: is Alice there at all?      (off | connecting | on | error)
 *     - mode:     how does she respond?        (conversation | passive)
 *     - activity: what is she doing right now? (idle | hearing | thinking | speaking | waiting_worker | reconnecting)
 *
 * The legacy ElevenLabs machine (`idle|connecting|listening|thinking|speaking`)
 * maps onto these axes via `mapLegacyVoiceState` (frontend, ui-evolution §1.2).
 * The legacy engine keeps emitting its own frames until `voice.engine='native'`
 * lands — the frontend translates them at the boundary (Fase 3 en paralelo).
 *
 * Naming (decisiones de Pablo #4 y Jordan): the silent mode is `passive` in
 * code and "En escucha — solo si me nombras" in UI — NOT `silent`, to avoid
 * confusion with mic mute (`muted`, a mechanical flag, orthogonal to all axes).
 */

// ============================================================================
// AXES
// ============================================================================

/** Presence axis — is there a voice session at all? */
export type VoicePresence = 'off' | 'connecting' | 'on' | 'error';

/**
 * Mode axis — how the agent responds to what it hears (REQ-6).
 * PoC 2026-10-31 (Pablo, decisions 1-2): three product modes —
 *   available    → "Disponible": answers when named, stores NOTHING it overhears
 *   passive      → "Escucha": answers when named, everything overheard enters context
 *   conversation → "Conversando": answers to everything
 */
export type VoiceMode = 'available' | 'passive' | 'conversation';

/** Activity axis — what is happening inside an active session. */
export type VoiceActivity =
  | 'idle' // presence on, nothing happening (reposo — VAD low)
  | 'hearing' // user is speaking (VAD high)
  | 'thinking' // agent is composing a response
  | 'speaking' // agent audio is playing
  | 'waiting_worker' // agent delegated to a worker (tool_call / channel_event)
  | 'reconnecting'; // unexpected disconnect, auto-retry in progress

/** Legacy 5-state machine kept for compatibility during the transition. */
export type VoiceSessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

// ============================================================================
// MODE METADATA (labels live in i18n; ids here are the contract)
// ============================================================================

export const VOICE_MODES: readonly VoiceMode[] = ['available', 'passive', 'conversation'] as const;

/** Default mode when a voice session starts (decisión de Pablo #4). */
export const VOICE_MODE_DEFAULT: VoiceMode = 'conversation';

/** Legacy backend mode values → v2 codes (REQ-6 correspondence table). */
export const VOICE_MODE_LEGACY_MAP: Record<string, VoiceMode> = {
  active: 'conversation',
  silent: 'passive',
};

// ============================================================================
// ERRORS (REQ-11 catalog — extends AF-7 with the native-loop codes)
// ============================================================================

/**
 * Typed voice error codes. AF-7 codes are kept as-is; `mic_permission` is
 * emitted client-side when getUserMedia is denied; `stt_*`/`tts_*` arrive with
 * the native loop (F1) and are accepted here from day one.
 */
export type VoiceErrorCode =
  | 'auth'
  | 'flag_disabled'
  | 'elevenlabs_signed_url'
  | 'timeout'
  | 'workspace_unresolved'
  | 'server_error'
  | 'bad_request'
  | 'mic_permission' // client-side: getUserMedia NotAllowedError
  | 'stt_error' // native loop: speech-to-text failure
  | 'tts_error' // native loop: text-to-speech failure
  | 'unknown';

export interface VoiceSessionError {
  code: VoiceErrorCode;
  message: string;
}

// ============================================================================
// TRANSCRIPTS
// ============================================================================

export interface VoiceTranscript {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  type?: 'transcript' | 'tool_call' | 'tool_result' | 'tool_error' | 'channel_event';
  /** REQ-9: heard-but-not-addressed (passive) — rendered tenue. */
  overheard?: boolean;
  /** For channel_event type */
  channelEvent?: {
    eventType: 'channel_started' | 'channel_finished' | 'channel_permission' | 'channel_resolved';
    observedChannelId?: string;
    observedChannelName?: string;
    toolName?: string;
    resolution?: 'granted' | 'denied';
  };
}

// ============================================================================
// V2 FRAMES (contract the native loop will emit — spec §1.4)
// ============================================================================

/**
 * Server→client frames of the v2 contract. The legacy ElevenLabs proxy
 * (`voice-handler.ts`) emits none of these yet — the frontend accepts them
 * from day one so the backend can adopt them without touching the UI again.
 */
export type VoiceServerFrame =
  | { type: 'audio_chunk'; audio_base_64: string }
  | { type: 'vad_state'; vadScore: number; speaking: boolean }
  | { type: 'interrupt'; playbackPositionMs: number }
  | { type: 'mode_changed'; mode: VoiceMode; source: 'voice' | 'ui' | 'system' }
  /** PoC 2026-10-31: the dialogue window opened for `openMs` ms (0 = closed) — the UI shows a transient "Conversando". */
  | { type: 'dialogue_window'; openMs: number }
  | { type: 'error'; code: VoiceErrorCode; message: string }
  | {
      type: 'transcript';
      text: string;
      isUser: boolean;
      partial?: boolean;
      overheard?: boolean;
    }
  | { type: 'agent_response_delta'; text: string }
  | { type: 'tts_chunk'; audio_base_64: string }
  | { type: 'tts_segment'; alignment: { chars: string[]; charStartTimesMs: number[]; charDurationsMs: number[] } | null }
  | { type: 'message_meta'; messageId: string; metadata: Record<string, unknown> }
  | { type: 'voice_channel'; channelId: string; historicTranscripts?: VoiceTranscript[] }
  | {
      type: 'channel_event';
      eventType: 'channel_started' | 'channel_finished' | 'channel_permission' | 'channel_resolved';
      observedChannelId?: string;
      observedChannelName?: string;
      toolName?: string;
      resolution?: 'granted' | 'denied';
    }
  | { type: 'tool_call'; toolName?: string; message?: string; parameters?: unknown }
  | { type: 'tool_result'; text?: string }
  | { type: 'tool_error'; error?: string }
  | { type: 'pong'; event_id?: string };

/** Client→server frames. `set_mode` is the UI door for the mode axis. */
export type VoiceClientFrame =
  | { type: 'set_mode'; mode: VoiceMode } // picker (UI door) — same ceremony as the voice door
  | { type: 'user_audio_chunk'; audio_base_64: string }
  | { type: 'interrupt'; playbackPositionMs: number } // barge-in with playback position (REQ-4)
  | { type: 'playback_ended' } // F5h: client's TTS queue drained — audio stopped sounding (real playback end)
  | { type: 'playback_started' } // PoC trace: the client's first TTS buffer started sounding
  | { type: 'playback_position'; positionMs: number } // PoC: the client's real playback position at the cut
  | { type: 'pong'; event_id?: string };

// ============================================================================
// LEGACY → V2 MAPPING (ui-evolution.md §1.2 — the exact table)
// ============================================================================

export interface LegacyVoiceSnapshot {
  /** Legacy machine state. */
  state: VoiceSessionState;
  /** WebSocket connected (handshake done). */
  isConnected: boolean;
  /** agentId of the active session (null when none). */
  activeAgentId: string | null;
  /** Auto-reconnection in progress. */
  isReconnecting: boolean;
  /** Typed error, null when healthy. */
  error: VoiceSessionError | null;
  /** VAD score 0-1 (ElevenLabs vad_score frames). */
  vadScore: number;
}

export interface VoiceAxesSnapshot {
  presence: VoicePresence;
  /** Meaningful only when presence === 'on'. */
  activity: VoiceActivity;
}

/**
 * Pure mapping from the legacy machine snapshot to the v2 axes — the exact
 * table from ui-evolution.md §1.2. Nothing is invented: VAD already separates
 * reposo/hearing, reconnection and typed errors already exist; they are just
 * split into orthogonal axes here.
 *
 * Kept pure + exported so it is unit-testable without a React tree.
 */
export function mapLegacyVoiceSnapshot(snapshot: LegacyVoiceSnapshot): VoiceAxesSnapshot {
  const { state, isConnected, activeAgentId, isReconnecting, error, vadScore } = snapshot;

  // Presence axis — error wins, then connection lifecycle, then agent presence.
  if (error) return { presence: 'error', activity: 'idle' };
  if (activeAgentId === null) return { presence: 'off', activity: 'idle' };
  if (state === 'connecting' && !isConnected) return { presence: 'connecting', activity: 'idle' };

  // Presence is 'on' from here — resolve the activity axis.
  if (isReconnecting) return { presence: 'on', activity: 'reconnecting' };
  switch (state) {
    case 'speaking':
      return { presence: 'on', activity: 'speaking' };
    case 'thinking':
      return { presence: 'on', activity: 'thinking' };
    case 'listening':
      // VAD already distinguishes reposo from hearing (ui-evolution §1.2)
      return { presence: 'on', activity: vadScore > 0.5 ? 'hearing' : 'idle' };
    case 'connecting':
      return { presence: 'on', activity: 'idle' };
    case 'idle':
    default:
      return { presence: 'on', activity: 'idle' };
  }
}

/**
 * Compatibility selector: collapse the axes back to the legacy 5-state machine
 * so un-migrated consumers keep working during the transition (ui-evolution
 * §2.1.1 — "selector de compatibilidad"). Only 3 consumers exist today and
 * they migrate in the same branch.
 */
export function axesToLegacyState(presence: VoicePresence, activity: VoiceActivity): VoiceSessionState {
  if (presence === 'off') return 'idle';
  if (presence === 'connecting') return 'connecting';
  if (presence === 'error') return 'idle';
  switch (activity) {
    case 'hearing':
      return 'listening';
    case 'thinking':
    case 'waiting_worker':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    case 'reconnecting':
      return 'listening';
    case 'idle':
    default:
      // presence 'on', reposo — legacy machine had no word for this
      return 'listening';
  }
}
