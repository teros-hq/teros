/**
 * VoiceSessionContext
 *
 * Global context that keeps the voice session active independently
 * of the ChatView lifecycle. The WebSocket and AudioContext live
 * here — they are never destroyed when switching tabs.
 *
 * Voice Mode v2 (ui-evolution.md §2.1): the state model is split into
 * THREE ORTHOGONAL AXES (contract in @teros/shared voice-frames):
 *
 *   presence × mode × activity
 *     - presence: off | connecting | on | error   — is Alice there?
 *     - mode:     conversation | passive | attention — how does she respond?
 *     - activity: idle | hearing | thinking | speaking | waiting_worker | reconnecting
 *
 * Nothing is invented: the VAD already separated reposo/hearing, reconnection
 * and typed errors already existed — they are split into axes here (§1.2).
 * `hearing` is derived from vadScore (real VAD, never simulated — AC-UX2).
 * The legacy 5-state machine is kept as a compatibility selector (`state`)
 * so un-migrated consumers keep compiling during the transition.
 *
 * Pattern:
 * - VoiceSessionProvider  → root of the workspace, always mounted
 * - useVoiceSession()     → consumed by ChatView (voice mode inline)
 * - startSession(agentId, resumeChannelId?, chatChannelId?) → starts connection for an agent
 * - stopSession()         → explicitly closes connection
 * - setMode(mode)         → v2 mode axis — UI door, same ceremony as the voice door
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  axesToLegacyState,
  mapLegacyVoiceSnapshot,
  VOICE_MODE_DEFAULT,
  VOICE_MODE_LEGACY_MAP,
  VOICE_MODES,
  type VoiceActivity,
  type VoiceErrorCode,
  type VoiceMode,
  type VoicePresence,
  type VoiceSessionError,
  type VoiceSessionState,
  type VoiceTranscript,
} from '@teros/shared';
import { useAuthStore } from '../store/authStore';
import { STORAGE_KEYS, storage } from '../services/storage';
import { useWakeLock } from '../hooks/useWakeLock';
import { useFeatureFlagsStore, getResolvedFlag } from '../store/featureFlagsStore';
import { earconForModeChange, useEarcons } from '../hooks/voice/useEarcons';
import { useTtsPlayer } from '../hooks/voice/useTtsPlayer';
// F5i: the AirPods/media-key play-pause → mic-mute door (Media Session API).
import { useMediaSession } from '../hooks/voice/useMediaSession';
// F5i: the metadata title carries the agent's display name ("Alice — sesión
// de voz") — resolved from the navbar cache (the same NavbarAgent list the
// sidebar renders), with a plain "Teros" fallback when the cache misses.
import { useNavbarStore } from '../store/navbarStore';
import { useChatStore } from '../store/chatStore';
import { useVoiceSpeakingStore } from '../store/voiceSpeakingStore';

// Re-export the v2 axes contract so existing consumers
// (`VoiceControls`, `VoiceVisualizer`, …) keep their imports working.
export type {
  VoiceActivity,
  VoiceErrorCode,
  VoiceMode,
  VoicePresence,
  VoiceSessionError,
  VoiceSessionState,
  VoiceTranscript,
} from '@teros/shared';
import { wsUrl as resolveWsUrl } from '../config/runtime';
export { VOICE_MODE_DEFAULT, VOICE_MODES };

// =============================================================================
// TYPES — the axes and errors live in @teros/shared (voice-frames contract);
// only the session-level interface is defined here.
// =============================================================================

/**
 * AF-7: Map a WebSocket close code to a typed voice error.
 * Returns `null` when the code is not a recognised HTTP rejection — the caller
 * should then fall through to reconnection logic.
 *
 * Exported as a pure function so it can be unit-tested without a React tree.
 */
export function mapVoiceCloseCode(code: number): VoiceSessionError | null {
  switch (code) {
    case 401:
      return { code: 'auth', message: 'Authentication failed — please log in again' };
    case 403:
      return { code: 'flag_disabled', message: 'Voice mode is not enabled for your account' };
    case 400:
      return { code: 'bad_request', message: 'Invalid request — missing or invalid parameters' };
    case 500:
      return { code: 'server_error', message: 'Server error — please try again' };
    default:
      return null;
  }
}

export interface VoiceSession {
  // ── v2 axes (ui-evolution.md §2.1.1 — the new model) ──────────────────────
  /** Presence axis: is there a voice session at all? */
  presence: VoicePresence;
  /** Mode axis: how the agent responds (REQ-6). Default `conversation` (decisión #4). */
  mode: VoiceMode;
  /**
   * PoC 2026-10-31: while set (epoch ms), the dialogue window is open — the
   * agent just answered a call by name and takes a follow-up without the
   * name. The UI paints it as a transient "Conversando" with a draining bar.
   */
  dialogueWindowUntil: number | null;
  /** Activity axis: what is happening inside an active session. */
  activity: VoiceActivity;
  /** v2: name of the worker the agent delegated to (for the WorkerTimerChip), null when none. */
  workerName: string | null;
  /** v2: reconnect attempt counter (n/5) — was already computed, only console-logged before. */
  reconnectAttempt: number;
  /** v2: last heard phrase (for the orb popover "¿qué has oído?"). */
  lastHeard: string | null;
  /**
   * v2 (F3b): epoch ms when the current presence stretch started — feeds the
   * PresenceDivider (opening receipt + closing receipt with real duration,
   * ui-evolution §3.5 / UX §5.5). Null when no session has started.
   */
  sessionStartedAt: number | null;
  /**
   * v2 (F3b): epoch ms when the current worker started (channel_started
   * frame) — feeds the WorkerTimerChip's live cronómetro (§3.8). Null when
   * no worker is running.
   */
  workerStartedAt: number | null;

  // ── Legacy machine (compatibility selector — ui-evolution §2.1.1) ──────────
  /**
   * Legacy 5-state machine, derived from the axes via `axesToLegacyState`.
   * Kept during the transition so un-migrated consumers keep compiling;
   * new UI must read `presence`/`mode`/`activity` instead.
   */
  state: VoiceSessionState;
  /** Whether there is an active WebSocket connection */
  isConnected: boolean;
  /** agentId currently being spoken to, null if no active session */
  activeAgentId: string | null;
  /** Chat channel where voice transcripts are written inline (when started from a chat window) */
  activeChatChannelId: string | null;
  /** Voice channel created by the backend */
  channelId: string | null;
  /** ElevenLabs conversation ID */
  conversationId: string | null;
  /** Transcripts from previous sessions (loaded from MongoDB on reconnect) */
  historicTranscripts: VoiceTranscript[];
  /** Live transcripts accumulated during the current session */
  liveTranscripts: VoiceTranscript[];
  /**
   * F5e: the CURRENT interim STT phrase — the user's words flowing live
   * while they are still speaking. View only: each interim replaces the
   * last; the final transcript clears it and enters liveTranscripts (and
   * the persisted history) as today. Null when nothing is being said.
   */
  interimTranscript: string | null;
  /** Combined transcripts (historic + live) — convenience for consumers that don't need the split */
  transcripts: VoiceTranscript[];
  /** Microphone audio level (0-1) */
  audioLevel: number;
  /** ElevenLabs VAD score (0-1) */
  vadScore: number;
  /** Whether the microphone is muted */
  isMuted: boolean;
  /** Whether auto-reconnection is in progress */
  isReconnecting: boolean;
  /** AF-7: Last init error (null when no error). Cleared on each new startSession attempt. */
  error: VoiceSessionError | null;
  /** Last persisted session (agentId + channelId) — available even when there is no active session */
  lastSession: { agentId: string; channelId: string; savedAt: number } | null;

  /** Starts a voice session with the given agent (optionally resuming a channel, optionally linked to a chat channel) */
  startSession: (agentId: string, resumeChannelId?: string, chatChannelId?: string, initialMode?: VoiceMode) => Promise<void>;
  /** Stops the active session (explicitly — does not reconnect) */
  stopSession: () => void;
  /** Toggles microphone mute */
  toggleMute: () => void;
  /**
   * v2: sets the mode axis (REQ-6). Sends the `set_mode` client frame over the
   * WS (UI door) — the same authoritative state the agent's voice door
   * (`set_mode` client tool) writes to; the backend broadcasts `mode_changed`
   * back to every client. Optimistically sets local state; reconciled by the
   * `mode_changed` frame. No-op without an active session.
   */
  setMode: (mode: VoiceMode) => void;
  /**
   * AF-7: Expose setError so consumers (e.g. ChatView) can surface an error
   * before startSession is called — e.g. when channel creation fails.
   * Pass null to clear the error.
   */
  setError: (error: VoiceSessionError | null) => void;
}

interface ElevenLabsMessage {
  type: string;
  [key: string]: any;
}

// =============================================================================
// CONTEXT
// =============================================================================

const VoiceSessionContext = createContext<VoiceSession | null>(null);

// =============================================================================
// PROVIDER
// =============================================================================

export function VoiceSessionProvider({ children }: { children: React.ReactNode }) {
  const sessionToken = useAuthStore((state) => state.sessionToken);

  // --- State ---
  // v2: the legacy machine state stays as the internal store; the three axes
  // are DERIVED from it (+ vadScore, isReconnecting, error) via the pure
  // mapping in @teros/shared (mapLegacyVoiceSnapshot, ui-evolution §1.2).
  // Nothing is duplicated — the axes are selectors, not a second machine.
  const [state, setState] = useState<VoiceSessionState>('idle');
  const [isConnected, setIsConnected] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeChatChannelId, setActiveChatChannelId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [historicTranscripts, setHistoricTranscripts] = useState<VoiceTranscript[]>([]);
  const [liveTranscripts, setLiveTranscripts] = useState<VoiceTranscript[]>([]);
  // F5c: audioLevel is a 60fps analog signal, but React state at 60fps
  // re-renders the whole tree each frame (Popover ref churn → "Maximum
  // update depth exceeded" crash with loud TTS). The rings smooth at 90ms
  // anyway — pushing only on REAL movement (delta > 0.004) and at most
  // every 33ms (~30fps) is visually identical and stops the storm.
  const audioLevelRef = useRef(0);
  const audioLevelLastPushRef = useRef(0);
  const setAudioLevelThrottled = useCallback((level: number) => {
    const now = performance.now();
    const delta = Math.abs(level - audioLevelRef.current);
    if (delta < 0.004 && level !== 0) return;
    if (now - audioLevelLastPushRef.current < 33) return;
    audioLevelRef.current = level;
    audioLevelLastPushRef.current = now;
    setAudioLevel(level);
  }, []);
  const [audioLevel, setAudioLevel] = useState(0);
  const [vadScore, setVadScore] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [error, setError] = useState<VoiceSessionError | null>(null);
  const [lastSession, setLastSession] = useState<{ agentId: string; channelId: string; savedAt: number } | null>(null);

  // --- v2 state (ui-evolution §2.1) ---
  /** Mode axis — synchronized by the `mode_changed` frame (F2b). Default `conversation` (decisión #4). */
  const [mode, setModeState] = useState<VoiceMode>(VOICE_MODE_DEFAULT);
  const [dialogueWindowUntil, setDialogueWindowUntil] = useState<number | null>(null);
  /** waiting_worker: name of the worker the agent delegated to (null when none). */
  const [workerName, setWorkerName] = useState<string | null>(null);
  /** Reconnect attempt counter (n/5) — exposed for "Reconectando… intento 2/5". */
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  /** Last heard phrase — feeds the orb popover "¿qué has oído?". */
  const [lastHeard, setLastHeard] = useState<string | null>(null);
  /**
   * F3b: when the current presence stretch started (epoch ms) — the receipt's
   * anchor (PresenceDivider §3.5). Set on startSession, kept across reconnects
   * (a reconnect is the same presence stretch), cleared on stop.
   */
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  /**
   * F3b: when the current worker started (epoch ms) — the WorkerTimerChip's
   * origin (§3.8). Cleared when the worker finishes/errors.
   */
  const [workerStartedAt, setWorkerStartedAt] = useState<number | null>(null);

  // --- Refs (never trigger re-renders) ---
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<{ stop: () => void; stream: MediaStream } | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const playbackAnimationFrameRef = useRef<number | null>(null);
  const agentSpeakingRef = useRef(false);
  // F5h: whether this turn already reported playback_ended to the server —
  // the drain edge fires once per turn, but a stale second edge (or a
  // re-entrant decode callback) must not double-send. Re-armed on the next
  // speaking_started (the new turn's first chunk).
  const playbackEndedSentRef = useRef(false);
  // PoC trace: whether this turn already reported playback_started.
  const playbackStartedSentRef = useRef(false);
  const isMutedRef = useRef(false);
  const stateRef = useRef<VoiceSessionState>('idle');
  // Reconnect control
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false); // true when user explicitly stops
  const activeAgentIdRef = useRef<string | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);
  const activeChatChannelIdRef = useRef<string | null>(null);

  // Load persisted last session on mount
  useEffect(() => {
    storage.get<{ agentId: string; channelId: string; savedAt: number }>(STORAGE_KEYS.VOICE_SESSION).then((parsed) => {
      if (parsed) setLastSession(parsed);
    });
  }, []);

  // Wake lock: keep the screen awake while a voice session is active.
  // Uses expo-keep-awake which abstracts web (Screen Wake Lock API) and
  // native (iOS/Android). Silently no-ops if the platform doesn't support it.
  useWakeLock(activeAgentId !== null);

  // Keep stateRef in sync (for use inside audio callbacks)
  useEffect(() => { stateRef.current = state; }, [state]);

  // ── v2 axes derivation (ui-evolution §2.1.1) ─────────────────────────────
  // The axes are SELECTORS over the existing state — no second machine, no
  // duplicated transitions. The mapping is the exact table from §1.2 and it
  // lives in @teros/shared so the backend extends the contract in one place.
  const { presence, activity: baseActivity } = mapLegacyVoiceSnapshot({
    state,
    isConnected,
    activeAgentId,
    isReconnecting,
    error,
    vadScore,
  });

  // waiting_worker overrides the derived activity when the agent delegated
  // to a worker (tool_call/channel_event) — the derived machine has no word
  // for it (§2.1.5).
  const activity: VoiceActivity =
    workerName !== null && baseActivity !== 'speaking' && baseActivity !== 'hearing'
      ? 'waiting_worker'
      : baseActivity;

  // ── Earcons (ui-evolution §3.6, UX §4.2) ─────────────────────────────────
  // The second state channel: every presence/mode/error transition is
  // audible. The context is the only place that knows when they happen.
  // Flag-gated (voice.mode-ui) — off = no sound is ever synthesized.
  const earcons = useEarcons();
  const earconsEnabled = getResolvedFlag<boolean>(
    useFeatureFlagsStore.getState(),
    'voice.mode-ui',
  );

  // ── Native engine TTS player (F3d) ───────────────────────────────────────
  // The native loop sends the agent's voice as `tts_chunk` frames (base64 MP3,
  // one sentence per MP3) — the legacy PCM pipeline (playAudio/playQueue)
  // cannot play those. This player owns the native engine's playback: strict
  // FIFO queue of decoded sentences, instant interrupt, own channel gain.
  // FLAG-GATED: the handlers only route frames when `voice.engine === 'native'`
  // — off = the hook sits idle and the legacy pipeline is untouched (zero
  // regression). The graph routes through the session's playback analyser
  // (playbackAnalyserRef) so the orb's speaking ring reads REAL playback
  // (AC-UX2) — the analyser is created lazily on first use (same pattern as
  // the legacy playAudio).
  const nativeEngineEnabled =
    getResolvedFlag<string>(useFeatureFlagsStore.getState(), 'voice.engine') === 'native';
  const ttsPlayer = useTtsPlayer();

  // ── F5g: background resilience — the session survives a hidden tab ──────
  // What already survives on its own (audited):
  //   • The WebSocket — no visibility/pagehide/beforeunload handler closes it.
  //   • The PCM flow — the AudioWorklet runs on the audio thread, immune to
  //     the hidden-tab timer throttling; it keeps sending ~256ms chunks, which
  //     doubles as the WS keepalive (no client-side ping timer to throttle).
  //   • ping/pong — the reply is sent in ws.onmessage directly, not on a timer.
  //   • RAF level polls (mic orb, playback ring) — they pause while hidden,
  //     but they are visualization only; they resume on their own.
  // What does NOT survive on its own: the browser may SUSPEND the
  // AudioContexts (capture 16 kHz + playback 24 kHz + the TTS player's own)
  // while the tab is hidden/minimized. A suspended capture context stops the
  // worklet → the mic dies in background; a suspended playback context
  // swallows the agent's voice. So: when the tab becomes visible again,
  // resume every context that the browser suspended. Never on 'hidden' —
  // hiding must not pause anything (the whole point of F5g).
  //
  // The player object is re-created every render (its methods are stable
  // useCallbacks, the literal is not) — read it through a ref so the
  // document listener attaches ONCE, not on every provider re-render
  // (audioLevel pushes re-render the provider ~30×/s during speech).
  const ttsPlayerRef = useRef(ttsPlayer);
  ttsPlayerRef.current = ttsPlayer;
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const resumeSuspendedContext = (ctx: AudioContext | null, label: string) => {
      if (!ctx || ctx.state !== 'suspended') return;
      ctx.resume().catch((err) => {
        console.warn(`[VoiceSession] resume(${label}) failed:`, err);
      });
      console.log(`[VoiceSession] Resumed suspended ${label} AudioContext (tab visible again)`);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      // Only meaningful with a live session — without one the contexts are
      // gone anyway (a hang-up closes them), nothing to resume.
      if (activeAgentIdRef.current === null) return;
      resumeSuspendedContext(audioContextRef.current, 'capture');
      resumeSuspendedContext(playbackContextRef.current, 'playback');
      // The native engine's player owns its context (or adopts the playback
      // one) — resume() is a safe no-op when it is running/absent.
      ttsPlayerRef.current.resume();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // The native turn's "back to idle" edge: the queue DRAINED after
  // speaking_ended — the audio the user was still hearing has finished. The
  // marks alone are not enough (the last sentence decodes asynchronously
  // after speaking_ended arrives); the drain edge is the truthful moment.
  // Registered via setOnPlaybackEnded so the queue chain always calls the
  // latest closure without re-creating the player's callbacks.
  useEffect(() => {
    ttsPlayer.setOnPlaybackEnded(() => {
      agentSpeakingRef.current = false;
      workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: false });
      if (stateRef.current === 'speaking') setState('listening');
      // F5h: report the TRUE playback end to the server — its barge-in
      // window (ttsActive) must cover the audio the user was still hearing
      // past the provider's send-end. Guards: session live + native engine
      // + not already sent this turn (the drain edge fires once, but a
      // stale re-entrant edge must not double-send). The server ignores the
      // frame when no epoch expects it (armed safety timer) — a late frame
      // after a barge-in or a new turn is a no-op there.
      if (
        nativeEngineEnabled &&
        !playbackEndedSentRef.current &&
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        playbackEndedSentRef.current = true;
        try {
          wsRef.current?.send(JSON.stringify({ type: 'playback_ended' }));
        } catch { /* socket died mid-send — the server's safety timeout covers it */ }
      }
      // The answer stopped sounding — the live spoken-text marking ends.
      useVoiceSpeakingStore.getState().stop();
    });
    return () => ttsPlayer.setOnPlaybackEnded(null);
  }, [ttsPlayer, nativeEngineEnabled]);

  // PoC 2026-10-31: while the answer sounds, publish how far into its text
  // the playback is (alignment clock) so that ONE bubble can paint the spoken
  // prefix normal and the unspoken tail muted. ~12 Hz; stops on drain.
  useEffect(() => {
    if (!nativeEngineEnabled) return;
    const id = setInterval(() => {
      const st = useVoiceSpeakingStore.getState();
      if (!st.messageId) return;
      st.tick(ttsPlayer.getSpokenCharIndex(), ttsPlayer.getAlignedCharCount());
    }, 80);
    return () => clearInterval(id);
  }, [ttsPlayer, nativeEngineEnabled]);

  // PoC trace (2026-10-31): report the instant the answer starts SOUNDING —
  // the latency the user perceives ends here, not at the server's first chunk.
  useEffect(() => {
    ttsPlayer.setOnPlaybackStarted(() => {
      if (!nativeEngineEnabled || playbackStartedSentRef.current) return;
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      playbackStartedSentRef.current = true;
      console.log(`[VoiceTrace:client] playback_started ${new Date().toISOString()}`);
      try { wsRef.current?.send(JSON.stringify({ type: 'playback_started' })); } catch { /* best effort */ }
    });
    return () => ttsPlayer.setOnPlaybackStarted(null);
  }, [ttsPlayer, nativeEngineEnabled]);

  // The native player's analyser: reuse the legacy playback analyser when it
  // exists, or create one on the (lazily created) playback context. Resolved
  // at wire time — the legacy playAudio creates its analyser on first PCM
  // frame; the native path creates it on first tts_chunk.
  const ensureNativeAnalyser = useCallback((): AnalyserNode | null => {
    if (playbackAnalyserRef.current) return playbackAnalyserRef.current;
    const ctx = playbackContextRef.current;
    if (!ctx || ctx.state === 'closed') return null;
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      playbackAnalyserRef.current = analyser;
      return analyser;
    } catch {
      return null;
    }
  }, []);
  void ensureNativeAnalyser; // (kept for the F3e wiring: the orb's ring tap)

  // ── Native playback level (F3d, AC-UX2) ───────────────────────────────────
  // The orb's speaking ring reads REAL playback: while the native player
  // sounds, poll ITS analyser (the player's own — created on first use) and
  // feed audioLevel, exactly like the legacy monitorPlayback does for PCM.
  // No animation ever simulates audio that does not exist: the loop only
  // runs while the player is actually playing.
  const nativeLevelFrameRef = useRef<number | null>(null);
  useEffect(() => {
    if (!nativeEngineEnabled) {
      if (nativeLevelFrameRef.current !== null) {
        cancelAnimationFrame(nativeLevelFrameRef.current);
        nativeLevelFrameRef.current = null;
      }
      return;
    }
    let alive = true;
    const poll = () => {
      if (!alive) return;
      if (ttsPlayer.isPlaying) {
        const analyser = ttsPlayer.getAnalyser();
        if (analyser) {
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setAudioLevelThrottled(avg / 255);
        }
      } else if (agentSpeakingRef.current === false) {
        // Not playing and not speaking — zero the level (the ring rests).
        setAudioLevel((prev) => (prev === 0 ? prev : 0));
      }
      nativeLevelFrameRef.current = requestAnimationFrame(poll);
    };
    poll();
    return () => {
      alive = false;
      if (nativeLevelFrameRef.current !== null) {
        cancelAnimationFrame(nativeLevelFrameRef.current);
        nativeLevelFrameRef.current = null;
      }
    };
  }, [nativeEngineEnabled, ttsPlayer]);


  // Presence on/off — ascending/descending soft tones.
  const prevPresenceRef = useRef<VoicePresence>('off');
  useEffect(() => {
    if (!earconsEnabled) {
      prevPresenceRef.current = presence;
      return;
    }
    if (presence === 'on' && prevPresenceRef.current !== 'on') earcons.play('presence_on');
    if (presence === 'off' && prevPresenceRef.current === 'on') earcons.play('presence_off');
    prevPresenceRef.current = presence;
  }, [presence, earconsEnabled, earcons]);

  // Mode changes — low/mid/high short notes (the ceremony's sound, UX §5).
  const prevModeRef = useRef<VoiceMode>(VOICE_MODE_DEFAULT);
  useEffect(() => {
    if (!earconsEnabled) {
      prevModeRef.current = mode;
      return;
    }
    if (mode !== prevModeRef.current && presence === 'on') {
      earcons.play(earconForModeChange(mode));
    }
    prevModeRef.current = mode;
  }, [mode, presence, earconsEnabled, earcons]);

  // Errors — the double low tone: something needs your attention.
  const prevErrorRef = useRef<VoiceSessionError | null>(null);
  useEffect(() => {
    if (!earconsEnabled) {
      prevErrorRef.current = error;
      return;
    }
    if (error && !prevErrorRef.current) earcons.play('error');
    prevErrorRef.current = error;
  }, [error, earconsEnabled, earcons]);


  // Sync agentSpeaking flag to worklet when it changes
  useEffect(() => {
    workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: agentSpeakingRef.current });
  });

  // F5f: sync the RMS mic gate mode to the worklet whenever the engine flag
  // resolves differently (the worklet is created once per session, but the
  // flag can change mid-session — e.g. flipped in settings and the session
  // reconnects with the worklet node still alive). Native → gate OFF (the
  // server-side VAD owns barge-in, speech onsets must reach the STT);
  // legacy → gate ON (the original ElevenLabs client-side barge-in guard).
  // The worklet defaults to gate ON, so a client that never sends micGate
  // keeps the legacy behavior — the legacy path is never broken.
  useEffect(() => {
    workletNodeRef.current?.port.postMessage({ type: 'micGate', value: !nativeEngineEnabled });
  }, [nativeEngineEnabled]);

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  const addTranscript = useCallback(
    (text: string, isUser: boolean, type?: VoiceTranscript['type'], overheard = false) => {
      setLiveTranscripts((prev) => [
        ...prev,
        {
          id: `${Date.now()}_${Math.random()}`,
          text,
          isUser,
          timestamp: Date.now(),
          type: type ?? 'transcript',
          // REQ-9: heard-but-not-addressed — rendered tenue by the UI
          overheard: overheard || undefined,
        },
      ]);
      // Track the last heard phrase for the orb popover "¿qué has oído?"
      if (isUser && text) setLastHeard(text);
    },
    [],
  );

  // ── F5e: interim transcripts — the user's words FLOWING live ───────────────
  // The backend streams partial STT results (Deepgram interim, partial:true)
  // while the user is still speaking. They are VIEW ONLY — the final is
  // persisted as today (persistTranscript on the backend); the interim never
  // enters liveTranscripts. One interim at a time: each replaces the last
  // (they are revisions of the same breath, not rows). The final (no partial)
  // clears it — the phrase consolidates into the thread as a real row.
  const [interimTranscript, setInterimTranscript] = useState<string | null>(null);

  /** Handles a transcript frame, interim or final (F5e). */
  const handleTranscriptFrame = useCallback(
    (text: string, isUser: boolean, partial: boolean, overheard: boolean) => {
      if (partial && isUser) {
        // Interim: replace, never accumulate — one flowing line.
        setInterimTranscript(text || null);
        return;
      }
      // Final: consolidate — the interim breathes its last, the real row is born.
      if (isUser) setInterimTranscript(null);
      addTranscript(text, isUser, 'transcript', overheard);
    },
    [addTranscript],
  );

  // ---------------------------------------------------------------------------
  // AUDIO PLAYBACK
  // ---------------------------------------------------------------------------

  const playQueue = useCallback(async (ctx: AudioContext) => {
    isPlayingRef.current = true;

    while (audioQueueRef.current.length > 0) {
      if (audioQueueRef.current.length === 0) break;

      const buffer = audioQueueRef.current.shift()!;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Route through playback analyser (which is already connected to destination)
      if (playbackAnalyserRef.current) {
        source.connect(playbackAnalyserRef.current);
      } else {
        source.connect(ctx.destination);
      }
      activeSourceRef.current = source;

      await new Promise<void>((resolve) => {
        source.onended = () => {
          activeSourceRef.current = null;
          resolve();
        };
        source.start();
      });
    }

    activeSourceRef.current = null;
    isPlayingRef.current = false;
    agentSpeakingRef.current = false;
    workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: false });
    setAudioLevel(0);

    if (stateRef.current === 'speaking') {
      setState('listening');
    }
  }, []);

  const playAudio = useCallback(async (base64Audio: string) => {
    try {
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      if (!playbackContextRef.current) {
        const newCtx = new AudioContext({ sampleRate: 24000 });
        playbackContextRef.current = newCtx;
        // Attach analyser for agent audio level monitoring
        const playbackAnalyser = newCtx.createAnalyser();
        playbackAnalyser.fftSize = 256;
        playbackAnalyserRef.current = playbackAnalyser;
        playbackAnalyser.connect(newCtx.destination);
        // Start monitoring agent audio level
        const dataArray = new Uint8Array(playbackAnalyser.frequencyBinCount);
        const monitorPlayback = () => {
          playbackAnalyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          if (agentSpeakingRef.current) {
            setAudioLevelThrottled(avg / 255);
          }
          playbackAnimationFrameRef.current = requestAnimationFrame(monitorPlayback);
        };
        monitorPlayback();
      }
      const ctx = playbackContextRef.current;

      if (ctx.state === 'suspended') await ctx.resume();

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x8000;
      }
      const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
      audioBuffer.copyToChannel(float32, 0);

      audioQueueRef.current.push(audioBuffer);
      if (!isPlayingRef.current) {
        playQueue(ctx);
      }
    } catch (err) {
      console.error('[VoiceSession] playAudio error:', err);
    }
  }, [playQueue]);

  // ---------------------------------------------------------------------------
  // AUDIO LEVEL MONITORING
  // ---------------------------------------------------------------------------

  const monitorAudioLevel = useCallback(() => {
    if (!analyserRef.current) return;
    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const update = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      // F5c: while the AGENT speaks, yield the audioLevel channel to the
      // playback level (native poll / legacy monitorPlayback). Both loops
      // write setAudioLevel every RAF frame and the LAST writer wins —
      // without this guard the (silent) mic level overwrites the real TTS
      // level and the orb's speaking ring never moves (AC-UX2 broken).
      if (!agentSpeakingRef.current) setAudioLevelThrottled(avg / 255);
      animationFrameRef.current = requestAnimationFrame(update);
    };
    update();
  }, []);

  // ---------------------------------------------------------------------------
  // AUDIO CAPTURE
  // ---------------------------------------------------------------------------

  /**
   * Sends a PCM ArrayBuffer to the WebSocket as base64 (zero-copy from the worklet)
   */
  const sendPcmBuffer = useCallback((buffer: ArrayBuffer) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Codificar Int16Array → base64 sin pasar por string intermedio
    const uint8 = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    wsRef.current.send(JSON.stringify({ user_audio_chunk: btoa(binary) }));
  }, []);

  const startAudioCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
      },
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);

    // Analyser for visualization (stays on main thread, it's lightweight)
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    source.connect(analyser);
    monitorAudioLevel();

    // --- AudioWorklet ---
    await audioContext.audioWorklet.addModule('/pcm-processor.js');
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    workletNodeRef.current = workletNode;

    // Sincronizar estado inicial
    workletNode.port.postMessage({ type: 'mute', value: isMutedRef.current });
    workletNode.port.postMessage({ type: 'agentSpeaking', value: agentSpeakingRef.current });
    // F5f: native engine → RMS mic gate OFF (the server-side VAD owns
    // barge-in; a client-side pre-filter eats speech onsets — the
    // "mic cortado" bug). Legacy engine → gate ON (byte-identical).
    workletNode.port.postMessage({ type: 'micGate', value: !nativeEngineEnabled });

    // Recibir chunks PCM del worklet (off main thread)
    workletNode.port.onmessage = (event) => {
      if (event.data.type === 'pcm') {
        sendPcmBuffer(event.data.buffer);
      }
    };

    source.connect(workletNode);
    // Worklet no necesita conectarse a destination para procesar

    mediaRecorderRef.current = {
      stream,
      stop: () => {
        workletNode.disconnect();
        workletNode.port.close();
        workletNodeRef.current = null;
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
      },
    };

    console.log('[VoiceSession] Audio capture started (AudioWorklet)');
  }, [monitorAudioLevel, sendPcmBuffer, nativeEngineEnabled]);

  const stopAudioCapture = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (playbackAnimationFrameRef.current) {
      cancelAnimationFrame(playbackAnimationFrameRef.current);
      playbackAnimationFrameRef.current = null;
    }
    setAudioLevel(0);
  }, []);

  // ---------------------------------------------------------------------------
  // MESSAGE HANDLER
  // ---------------------------------------------------------------------------

  const handleServerMessage = useCallback(async (message: ElevenLabsMessage) => {
    if (message.type !== 'audio') {
      console.log('[VoiceSession] Received:', message.type);
    }

    switch (message.type) {
      case 'conversation_initiation_metadata':
        setConversationId(message.conversation_initiation_metadata_event?.conversation_id);
        setState('listening');
        break;

      case 'user_transcript': {
        // REQ-9: in passive mode, non-addressed speech enters as
        // overheard (rendered tenue). The legacy engine never flags it —
        // the native loop (F2) will; the UI is ready for both.
        const text = message.user_transcription_event?.user_transcript;
        let overheard = message.overheard === true;
        // F3b MOCK (until F2b): the legacy engine has no invocation gate, so
        // in passive mode nothing the user says is *addressed* — the
        // engine simply injects it silently (see voice-handler's silent-mode
        // injection). Flag it as overheard so the tenue row renders and the
        // contract is exercised. Dev-only + flag-gated: remove when F2b lands.
        if (
          !overheard &&
          text &&
          mode === 'passive' &&
          getResolvedFlag<boolean>(
            useFeatureFlagsStore.getState(),
            'voice.overheard-mock',
          )
        ) {
          overheard = true;
        }
        addTranscript(text, true, 'transcript', overheard);
        break;
      }

      // ── v2 contract frames (voice-frames.ts) — accepted from day one so
      // the backend (F1/F2) can adopt them without touching the UI again ──
      case 'transcript': {
        // F5e: partial:true = interim STT — the user's words flowing live
        // (view only, replaced by the next interim, consolidated by the
        // final). No partial = the final, persisted by the backend as today.
        handleTranscriptFrame(
          message.text,
          message.isUser === true,
          message.partial === true,
          message.overheard === true,
        );
        break;
      }

      case 'dialogue_window': {
        const openMs = typeof message.openMs === 'number' ? message.openMs : 0;
        setDialogueWindowUntil(openMs > 0 ? Date.now() + openMs : null);
        break;
      }
      case 'mode_changed': {
        // F2b: authoritative mode change (voice door or UI door, broadcast
        // to every client). Accepts legacy `active|silent` too (REQ-6 map).
        const raw = message.mode as string | undefined;
        const next =
          raw && (VOICE_MODES as readonly string[]).includes(raw)
            ? (raw as VoiceMode)
            : VOICE_MODE_LEGACY_MAP[raw ?? ''];
        if (next) {
          console.log('[VoiceSession] mode_changed →', next, '(source:', message.source ?? 'unknown', ')');
          setModeState(next);
        } else {
          console.warn('[VoiceSession] mode_changed with unknown mode:', raw);
        }
        break;
      }

      case 'agent_response':
        addTranscript(message.agent_response_event?.agent_response, false);
        setState('thinking');
        break;

      case 'audio':
        agentSpeakingRef.current = true;
        workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: true });
        await playAudio(message.audio_event.audio_base_64);
        setState('speaking');
        break;

      // ── Native engine frames (F3d, voice-frames.ts) — tts_chunk (base64
      // MP3, one sentence per MP3), speaking marks, and the interrupt echo
      // (barge-in, REQ-4). FLAG-GATED: only routed when voice.engine ===
      // 'native' — the legacy engine never emits these, and with the flag off
      // the handlers are dead code (zero regression). ──
      case 'tts_chunk': {
        if (!nativeEngineEnabled) break;
        agentSpeakingRef.current = true;
        workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: true });
        ttsPlayer.feedChunk(message.audio_base_64 ?? '');
        break;
      }

      case 'tts_segment': {
        // PoC 2026-10-31: decode the segment NOW (half-sentence latency) and
        // keep its character timing for the spoken-text clock.
        if (!nativeEngineEnabled) break;
        ttsPlayer.feedSegmentEnd(message.alignment ?? null);
        break;
      }

      case 'message_meta': {
        // A thread message gained metadata (e.g. voice.spokenChars after a
        // cut) — patch the chat store so the bubble repaints live.
        if (typeof message.messageId === 'string' && message.metadata) {
          const store = useChatStore.getState();
          const current = store.messages[message.messageId];
          store.updateMessage(message.messageId, {
            metadata: { ...(current?.metadata ?? {}), ...(message.metadata as Record<string, unknown>) },
          });
        }
        break;
      }

      case 'speaking_started': {
        if (!nativeEngineEnabled) break;
        // The marks are the source of truth for the activity axis (the native
        // loop emits no legacy 'speaking' state frames): the orb's ring and
        // the bar's label both derive from here.
        // PoC 2026-10-31: a NEW turn's audio supersedes whatever is still
        // sounding (Pablo: the previous answer kept playing under the next
        // message). Cut it before re-arming.
        if (ttsPlayer.isPlaying) ttsPlayer.stop();
        ttsPlayer.onSpeakingStarted();
        // F5h: a new turn's audio is coming — re-arm the playback_ended
        // report so this turn's drain edge reaches the server once.
        playbackEndedSentRef.current = false;
        playbackStartedSentRef.current = false;
        useVoiceSpeakingStore.getState().start(typeof message.messageId === 'string' ? message.messageId : null);
        setState('speaking');
        break;
      }

      case 'speaking_ended': {
        if (!nativeEngineEnabled) break;
        // The stream ended — flush the last sentence into the queue. The
        // "back to idle" transition fires when the queue DRAINS (the
        // onPlaybackEnded callback): the audio the user is still hearing is
        // real — the mark only says no more is coming.
        ttsPlayer.onSpeakingEnded();
        break;
      }

      case 'interrupt': {
        if (!nativeEngineEnabled) break;
        // Barge-in echo (REQ-4): the backend already cancelled the synthesis
        // (F1b) — the client just stops playing, NOW. source.stop() silences
        // on the spot; the queue and the half-arrived sentence are dropped.
        // PoC 2026-10-31: report the REAL playback position first — the
        // server refines the heard text / the cut mark with it.
        const cutPositionMs = Math.round(ttsPlayer.getPositionMs());
        ttsPlayer.stop();
        useVoiceSpeakingStore.getState().stop();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          try { wsRef.current.send(JSON.stringify({ type: 'playback_position', positionMs: cutPositionMs })); } catch { /* best effort */ }
        }
        agentSpeakingRef.current = false;
        workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: false });
        if (stateRef.current === 'speaking') setState('listening');
        break;
      }

      case 'ping':
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'pong',
            event_id: message.ping_event.event_id,
          }));
        }
        break;

      case 'vad_score':
        setVadScore(message.vad_score_event?.vad_score ?? 0);
        if ((message.vad_score_event?.vad_score ?? 0) > 0.5 && stateRef.current !== 'speaking') {
          setState('listening');
        }
        break;

      case 'voice_channel': {
        const newChannelId = message.channelId;
        setChannelId(newChannelId);
        activeChannelIdRef.current = newChannelId;
        // Hydrate historic transcripts if the backend sent them (resume scenario)
        if (message.historicTranscripts && Array.isArray(message.historicTranscripts)) {
          setHistoricTranscripts(message.historicTranscripts as VoiceTranscript[]);
        }
        // Persist session so we can resume later
        if (activeAgentIdRef.current && newChannelId) {
          const sessionData = {
            agentId: activeAgentIdRef.current,
            channelId: newChannelId,
            savedAt: Date.now(),
          };
          storage.set(STORAGE_KEYS.VOICE_SESSION, sessionData).catch(() => {});
          setLastSession(sessionData);
        }
        break;
      }

      case 'channel_event': {
        // Observed channel lifecycle events — show in transcript
        const { eventType, observedChannelId, observedChannelName, toolName, resolution } = message;
        setLiveTranscripts((prev) => [
          ...prev,
          {
            id: `${Date.now()}_${Math.random()}`,
            text: '',
            isUser: false,
            timestamp: Date.now(),
            type: 'channel_event' as const,
            channelEvent: { eventType, observedChannelId, observedChannelName, toolName, resolution },
          },
        ]);
        // v2 (§2.1.5): a started worker means the agent delegated — activity
        // becomes waiting_worker with the worker name (for the timer chip).
        // channel_finished clears it (back to thinking→speaking).
        if (eventType === 'channel_started' && observedChannelName) {
          setWorkerName(observedChannelName);
          // F3b (§3.8): the worker's start time — the live cronómetro's origin.
          setWorkerStartedAt(Date.now());
        } else if (eventType === 'channel_finished') {
          setWorkerName(null);
          setWorkerStartedAt(null);
        }
        break;
      }

      case 'tool_call': {
        const toolName = message.toolName ?? 'send-message';
        let toolText = `🛠️ ${toolName}`;
        if (toolName === 'send-message' && message.message) {
          toolText += `: "${message.message}"`;
        } else if (message.parameters) {
          const params = message.parameters as Record<string, any>;
          const relevant = Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join(', ');
          if (relevant) toolText += ` (${relevant})`;
        }
        addTranscript(toolText, true, 'tool_call');
        // v2 (§2.1.5): delegation to a worker → waiting_worker. The worker
        // name arrives with channel_started; until then use the tool name.
        setWorkerName((prev) => prev ?? (message.workerName as string | undefined) ?? toolName);
        break;
      }

      case 'tool_result':
        addTranscript(message.text ?? '', false, 'tool_result');
        // v2 (§2.1.5): the worker answered — back to thinking→speaking
        setWorkerName(null);
        setWorkerStartedAt(null);
        break;

      case 'tool_error':
        addTranscript(`❌ Error: ${message.error}`, false, 'tool_error');
        setWorkerName(null);
        setWorkerStartedAt(null);
        break;

      case 'interruption':
        if (activeSourceRef.current) {
          try { activeSourceRef.current.stop(); } catch (err) {
            // Stopping an already-stopped/finished source is expected during
            // interruptions; anything else should be visible.
            console.debug('[VoiceSession] audio source stop on interruption failed:', err);
          }
          activeSourceRef.current = null;
        }
        audioQueueRef.current = [];
        agentSpeakingRef.current = false;
        isPlayingRef.current = false;
        setState('listening');
        break;

      case 'error':
        // AF-7: process typed error frames from the backend
        console.error('[VoiceSession] Server error:', message.error, message.code);
        {
          const code = (message.code as VoiceErrorCode) || 'unknown';
          const msg = message.message || message.error || 'Unknown error';
          setError({ code, message: msg });
          setState('idle');
        }
        break;
    }
  }, [addTranscript, handleTranscriptFrame, playAudio, mode, nativeEngineEnabled, ttsPlayer]);

  // Keep a ref so the WS onmessage always calls the latest version
  const handleServerMessageRef = useRef(handleServerMessage);
  handleServerMessageRef.current = handleServerMessage;

  // ---------------------------------------------------------------------------
  // SESSION LIFECYCLE
  // ---------------------------------------------------------------------------

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const stopSession = useCallback((intentional = true) => {
    console.log(`[VoiceSession] Stopping session (intentional=${intentional})`);

    intentionalStopRef.current = intentional;
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;

    stopAudioCapture();
    // F3d: the native engine's player stops with the session (its own
    // context/queue die here — a session stop is not an interrupt, it is
    // the end of presence).
    ttsPlayer.stop();

    if (wsRef.current) {
      wsRef.current.close(1000, 'user_stop');
      wsRef.current = null;
    }

    if (playbackContextRef.current) {
      playbackContextRef.current.close();
      playbackContextRef.current = null;
    }

    audioQueueRef.current = [];
    isPlayingRef.current = false;
    agentSpeakingRef.current = false;

    setIsConnected(false);
    setIsReconnecting(false);
    if (intentional) {
      // Only clear agent/channel on intentional stop
      // On unexpected disconnect we keep them for reconnect
      setActiveAgentId(null);
      activeAgentIdRef.current = null;
      setActiveChatChannelId(null);
      activeChatChannelIdRef.current = null;
      setChannelId(null);
      activeChannelIdRef.current = null;
      setConversationId(null);
      setHistoricTranscripts([]);
      setLiveTranscripts([]);
      // F5e: the flowing interim dies with the session — no half-said words
      // survive a hang up.
      setInterimTranscript(null);
    }
    setVadScore(0);
    setIsMuted(false);
    isMutedRef.current = false;
    // AF-7: clear error on intentional stop
    if (intentional) setError(null);
    setState('idle');
    // v2: reset the session-scoped fields. The mode axis persists across
    // reconnects (it comes from the backend voice_sessions) — it is NOT
    // reset here, only on a fresh startSession for another agent.
    setWorkerName(null);
    setReconnectAttempt(0);
    setLastHeard(null);
    // F3b: close the presence stretch — the receipt's end. The closing
    // divider itself is rendered by ChatView (it observes the transition).
    setSessionStartedAt(null);
    setWorkerStartedAt(null);
  }, [stopAudioCapture, clearReconnectTimer, ttsPlayer]);

  // Core connect logic — separated so reconnect can call it too
  const connectWebSocket = useCallback(async (agentId: string, resumeChannelId?: string, chatChannelId?: string, initialMode?: VoiceMode) => {
    if (!sessionToken) throw new Error('No session token');

    const baseWsUrl = resolveWsUrl();
    if (!baseWsUrl) throw new Error('WebSocket URL is not configured');

    const url = new URL(baseWsUrl);
    url.pathname = '/voice';
    url.searchParams.set('sessionId', sessionToken);
    url.searchParams.set('agentId', agentId);
    if (resumeChannelId) {
      url.searchParams.set('channelId', resumeChannelId);
    }
    if (chatChannelId) {
      url.searchParams.set('chatChannelId', chatChannelId);
    }
    // PoC 2026-10-31: the door asks for the starting mode (navbar → available)
    // so the backend opens the session already in it — no first-utterance race.
    if (initialMode) {
      url.searchParams.set('mode', initialMode);
    }
    const wsUrl = url.toString();

    console.log(`[VoiceSession] Connecting to: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      console.log('[VoiceSession] WebSocket connected');
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
      setIsReconnecting(false);
      setState('connecting');

      ws.send(JSON.stringify({ type: 'conversation_initiation_client_data' }));

      try {
        await startAudioCapture();
      } catch (err) {
        // v2 (§2.1.3): getUserMedia denied → typed mic_permission error.
        // Today the failure only closed the WS and the user never knew why.
        // NOT reconnected — a permission denial is not transient.
        const isPermissionError =
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
        console.error('[VoiceSession] Failed to start audio capture:', err);
        if (isPermissionError) {
          intentionalStopRef.current = true; // don't auto-reconnect a denied mic
          setError({
            code: 'mic_permission',
            message: 'Microphone permission denied — allow it in your browser/site settings',
          });
          setState('idle');
        }
        ws.close();
      }
    };

    ws.onmessage = async (event) => {
      try {
        const raw = event.data instanceof Blob ? await event.data.text() : event.data;
        const message: ElevenLabsMessage = JSON.parse(raw);
        handleServerMessageRef.current(message);
      } catch (err) {
        console.error('[VoiceSession] Error parsing message:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('[VoiceSession] WebSocket error:', err);
    };

    ws.onclose = (event) => {
      console.log('[VoiceSession] WebSocket closed', event.code, event.reason);
      setIsConnected(false);
      stopAudioCapture();

      // AF-7: map HTTP rejection close codes to typed errors.
      // The server-bootstrap rejects before WS upgrade with:
      //   401 → auth, 403 → flag_disabled, 400 → bad_request, 500 → server_error
      // 400 and 500 are terminal (no reconnection); 401/403 are also terminal.
      // Only unmapped unexpected close codes fall through to reconnection.
      const mappedError = mapVoiceCloseCode(event.code);
      if (mappedError) {
        setError(mappedError);
        setState('idle');
        return;
      }

      // Don't reconnect if intentional stop or normal closure
      if (intentionalStopRef.current || event.code === 1000) {
        setState('idle');
        return;
      }

      // Unexpected disconnect — attempt reconnect with backoff
      const agentToReconnect = activeAgentIdRef.current;
      const channelToResume = activeChannelIdRef.current;
      const chatChannelToResume = activeChatChannelIdRef.current;

      if (!agentToReconnect) {
        setState('idle');
        return;
      }

      const MAX_ATTEMPTS = 5;
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      // v2 (§2.1.4): expose the attempt counter — it was already computed
      // here but only ever reached the console. "Reconectando… intento 2/5".
      setReconnectAttempt(attempt);

      if (attempt > MAX_ATTEMPTS) {
        console.warn('[VoiceSession] Max reconnect attempts reached, giving up');
        setState('idle');
        setIsReconnecting(false);
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
      console.log(`[VoiceSession] Reconnecting in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);

      setIsReconnecting(true);
      setState('idle');

      reconnectTimerRef.current = setTimeout(() => {
        console.log(`[VoiceSession] Reconnect attempt ${attempt}`);
        connectWebSocket(agentToReconnect, channelToResume ?? undefined, chatChannelToResume ?? undefined).catch((err) => {
          console.error('[VoiceSession] Reconnect failed:', err);
        });
      }, delay);
    };
  }, [sessionToken, startAudioCapture, stopAudioCapture]);

  const startSession = useCallback(async (agentId: string, resumeChannelId?: string, chatChannelId?: string, initialMode?: VoiceMode) => {
    if (!sessionToken) throw new Error('No session token');

    // AF-7: clear any previous error when starting a new session
    setError(null);

    // If there's already an active session for this agent, do nothing
    if (wsRef.current?.readyState === WebSocket.OPEN && activeAgentIdRef.current === agentId) {
      console.log('[VoiceSession] Already connected to agent', agentId);
      return;
    }

    // If there's a session with another agent, close it first
    if (wsRef.current) {
      stopSession(true);
    }

    intentionalStopRef.current = false;
    reconnectAttemptsRef.current = 0;

    setState('connecting');
    setActiveAgentId(agentId);
    activeAgentIdRef.current = agentId;

    // F3b (§3.5): the presence stretch begins — the receipt's anchor.
    setSessionStartedAt(Date.now());

    // Store chatChannelId for reconnect
    setActiveChatChannelId(chatChannelId ?? null);
    activeChatChannelIdRef.current = chatChannelId ?? null;

    // Determine which channelId to use
    // Priority: explicit resumeChannelId > lastSession channelId (if same agent)
    let channelToResume = resumeChannelId;
    if (!channelToResume) {
      const parsed = await storage.get<{ agentId: string; channelId: string; savedAt: number }>(STORAGE_KEYS.VOICE_SESSION);
      if (parsed && parsed.agentId === agentId) {
        channelToResume = parsed.channelId;
        console.log(`[VoiceSession] Auto-resuming last session channel: ${channelToResume}`);
      }
    }

    if (channelToResume) {
      activeChannelIdRef.current = channelToResume;
      // Don't clear live transcripts when resuming — historic will be hydrated from backend
    } else {
      // Fresh session: clear both historic and live
      setHistoricTranscripts([]);
      setLiveTranscripts([]);
    }

    await connectWebSocket(agentId, channelToResume, chatChannelId, initialMode);
  }, [sessionToken, stopSession, connectWebSocket]);

  const toggleMute = useCallback(() => {
    isMutedRef.current = !isMutedRef.current;
    setIsMuted(isMutedRef.current);
    // Mute gates CAPTURE only (the mic worklet) — never the playback channel.
    // Muting the mic is not "shut up": Alice keeps speaking, the user just
    // stops being heard (Pablo, 2026-10-05 — the legacy "mute = cut" ceremony
    // was the bug).
    workletNodeRef.current?.port.postMessage({ type: 'mute', value: isMutedRef.current });
  }, []);

  // ── F5i: AirPods / media-key play-pause → mic mute ──────────────────────
  // While a NATIVE-engine session is live, the app claims the browser's
  // now-playing session (Media Session API): the AirPods stem (play/pause),
  // the macOS media keys and the iOS lock-screen button all arrive as
  // play/pause action events → the SAME toggleMute above (toggle semantics —
  // whatever the OS sends, the mic flips). playbackState stays 'playing'
  // for the whole session (TTS sounding or not) so the OS never routes the
  // buttons elsewhere; a looping near-silent <audio> (public/near-silence.wav,
  // LSB samples at volume 1 — F5i-b) keeps
  // the claim alive through the silences. Legacy engine (voice.engine ≠
  // 'native') or no session → nothing is ever claimed, the OS keeps its
  // buttons (zero regression). The iOS lock screen shows "Teros · <agent>
  // — sesión de voz" with the play/pause button — that press toggles too.
  // @todo iria - 2026.10.05 : next/prev track (double/triple stem press)
  // could map to cycling the listening mode — open question with Pablo.
  const mediaSessionAgentName = useNavbarStore((s) => {
    if (!activeAgentId) return 'Teros';
    return s.agents.find((a) => a.agentId === activeAgentId)?.name ?? 'Teros';
  });
  useMediaSession({
    active: nativeEngineEnabled && activeAgentId !== null,
    agentName: mediaSessionAgentName,
    onToggleMute: toggleMute,
  });

  // v2 (§2.1.2): the UI door for the mode axis. Sends the `set_mode` client
  // frame over the WS — the same authoritative state the agent's voice door
  // writes to; the backend broadcasts `mode_changed` back to every client
  // (two tabs, same ceremony — UX §5.4). Optimistic local set; reconciled by
  // the `mode_changed` frame. No-op without an open session.
  const setMode = useCallback((next: VoiceMode) => {
    setModeState(next);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'set_mode', mode: next }));
      console.log('[VoiceSession] set_mode →', next, '(UI door)');
    } else {
      console.warn('[VoiceSession] set_mode without open WS — local only');
    }
  }, []);

  // AF-7: expose setError so consumers (ChatView) can surface errors before
  // startSession is called — e.g. when channel creation fails.
  const exposedSetError = useCallback((err: VoiceSessionError | null) => {
    setError(err);
  }, []);

  // Cleanup al desmontar el provider (cierre de browser/logout)
  useEffect(() => {
    return () => {
      intentionalStopRef.current = true;
      stopSession(true);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // CONTEXT VALUE
  // ---------------------------------------------------------------------------

  const value: VoiceSession = {
    // ── v2 axes (ui-evolution §2.1.1) ──
    presence,
    mode,
    activity,
    workerName,
    reconnectAttempt,
    lastHeard,
    dialogueWindowUntil,
    sessionStartedAt,
    workerStartedAt,
    // Legacy compatibility selector — derived from the axes so consumers
    // that still read `state` see waiting_worker as `thinking` etc.
    state: axesToLegacyState(presence, activity),
    isConnected,
    activeAgentId,
    activeChatChannelId,
    channelId,
    conversationId,
    historicTranscripts,
    liveTranscripts,
    interimTranscript,
    transcripts: [...historicTranscripts, ...liveTranscripts],
    audioLevel,
    vadScore,
    isMuted,
    isReconnecting,
    error,
    lastSession,
    startSession,
    stopSession,
    toggleMute,
    setMode,
    setError: exposedSetError,
  };

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}

// =============================================================================
// HOOK
// =============================================================================

export function useVoiceSession(): VoiceSession {
  const ctx = useContext(VoiceSessionContext);
  if (!ctx) {
    throw new Error('useVoiceSession must be used inside VoiceSessionProvider');
  }
  return ctx;
}
