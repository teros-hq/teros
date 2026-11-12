/**
 * Voice Loop — the native voice engine (Voice Mode v2, F1a)
 *
 * Spec v1.1.0 REQ-1 + REQ-3, decisión #1 (loop nativo, sin v1.5):
 *
 *   mic → backend → STT streaming (Deepgram Nova-3)  → interim → frontend
 *                                                └→ final utterance
 *                     → agente Teros como cerebro (messageHandler.processAgentResponse
 *                       en el canal de conversación, source:'voice' — the SAME
 *                       path as a text message; there is NO second LLM)
 *                     → respuesta (text_chunk broadcasts)
 *                     → TTS streaming (ElevenLabs Flash) → tts_chunk frames → cliente
 *
 * The legacy ElevenLabs ConvAI proxy (`voice-handler.ts`, the "cerebro doble")
 * stays untouched behind the `voice.engine` feature flag — `server-bootstrap`
 * dispatches per connection: 'native' → this loop, 'elevenlabs' → legacy proxy.
 *
 * Single channel (F0, REQ-2): the voice session lives IN the conversation
 * channel. User transcripts persist once with source:'voice' (channel_messages
 * for the UI); the agent turn persists itself through the normal text
 * pipeline (session_messages via ConversationManager.prompt + assistant
 * messages via streaming-state) — this loop never re-persists the response.
 *
 * Mode axis (F2a, REQ-7 complete): the invocation gate now runs the full
 * 3-layer model BEFORE the conversation LLM (see services/voice-gate.ts):
 *   - Layer 1 vocative — "Alice, …" opens in ALL modes (the guaranteed ladder);
 *   - Layer 2 target-of-speech classifier — REMOVED with `attention` (Pablo
 *     2026-10-05: two modes only; in passive the vocative is the only door);
 *   - Layer 3 dialogue context — `conversation`: everything is a turn; the
 *     LLM decides response-worthiness through the conversation context — the
 *     voice-session context note (buildVoiceTurnContext) rides the first
 *     turn after connect/mode change.
 * A third-person mention of the agent never fires in ANY mode. Non-activated
 * utterances persist as `overheard` (REQ-9 — F2b makes them visible-tenue).
 * Gate decisions are telemetered per utterance (services/voice-gate-telemetry.ts
 * — REQ-11/UC-12: mode, layer, score, activated).
 *
 * Barge-in (REQ-4, complete since F1b): two trigger paths, both immediate —
 *   1. VAD server-side: the STT's onSpeechStart (first interim of a new
 *      utterance) while the TTS is speaking → cut without waiting for any
 *      transcript (spec §Barge-in: VAD del lado STT).
 *   2. Client frame `interrupt { playbackPositionMs }` (client-side VAD /
 *      button) → cut + the client's authoritative playback position.
 * Both funnel into handleBargeIn: cancel the in-flight TTS + pending queue,
 * freeze the old turn's TTS (no new streams for its late text chunks — never
 * two audios at once), and register the playback position (what the user
 * actually heard) as conversation context. The interrupting utterance then
 * enters the pipeline through the normal handleFinalTranscript path — the
 * text pipeline's boundary_aware interrupt strategy gives it priority over
 * the old turn at the next boundary (no waiting for the old turn to finish).
 *
 * STT/TTS are injected via factories (tests mock them; production wires
 * DeepgramStreamingTranscriptionProvider + ElevenLabsFlashTtsProvider with
 * keys from SecretsManager). The loop never talks to a vendor SDK directly
 * (NFR-5: swappable commodities).
 */

import type { Db } from 'mongodb';
import type WebSocket from 'ws';
import { AuthService } from '../auth/auth-service';
import { assertCanCreateChannel } from '../services/channel-authz';
import type { ChannelManager } from '../services/channel-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { PubSubService, ChannelMessageListener } from '../services/pubsub-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { FeatureFlagService } from '../services/feature-flag-service';
import type { MessageHandler } from './message-handler';
import type { SessionStore } from '@teros/core';
import type { IStreamingTranscriptionProvider } from '../services/transcription/IStreamingTranscriptionProvider';
import { DeepgramStreamingTranscriptionProvider } from '../services/transcription/DeepgramStreamingTranscriptionProvider';
import type { ITtsProvider, TtsAlignment } from '../services/tts/ITtsProvider';
import { ElevenLabsFlashTtsProvider } from '../services/tts/ElevenLabsFlashTtsProvider';
import { ElevenLabsStreamTtsProvider } from '../services/tts/ElevenLabsStreamTtsProvider';
import type {
  VoiceMode,
  VoiceLoopServerFrame,
  VoiceLoopHistoricTranscript,
} from './voice-loop-frames';
import { parseVoiceLoopClientFrame } from './voice-loop-frames';
import { TurnLatencyTrace, VoiceLoopLatencyBudget } from '../services/voice-loop-latency';
import type { LatencyStats, TtsMode } from '../services/voice-loop-latency';
import {
  evaluateInvocationGate,
  buildVoiceTurnContext,
  isClosurePhrase,
} from '../services/voice-gate';
import type { GateDecision, GateDialogueState } from '../services/voice-gate';
import { parseVoiceModeCommand } from '../services/voice-mode-commands';
import { VoiceGateTelemetry } from '../services/voice-gate-telemetry';
import type { GateTelemetryStats } from '../services/voice-gate-telemetry';
import { VoiceSessionTelemetry } from '../services/voice-session-telemetry';
import type { VoiceSessionTelemetrySnapshot } from '../services/voice-session-telemetry';
import { rollupGateDecisions } from '../services/voice-session-telemetry';
import { fillerChunkFrames } from '../services/voice-filler';
import { resolveApiToken } from '../auth/api-tokens';

// Re-export the layer-1 pure function from its new home (voice-gate.ts) so
// existing imports keep working — the canonical export is the gate module.
export { isVocativeAddress } from '../services/voice-gate';

// ============================================================================
// TYPES
// ============================================================================

interface VoiceLoopConnection {
  clientWs: WebSocket;
  userId: string;
  workspaceId: string;
  /** The conversation channel — the single channel (F0, REQ-2). */
  channelId: string;
  agentId: string;
  sessionId: string;
  agentName: string;
  /** Canonical mode: 'conversation' (default) | 'passive'. */
  mode: VoiceMode;
  stt: IStreamingTranscriptionProvider;
  tts: ITtsProvider;
  /**
   * Which TTS strategy this connection runs (F5d, flag voice.tts): the
   * provider is picked per connection at handshake time; stamped on the
   * latency trace when the stream opens so the budget can split the TTS
   * histogram by mode (stream vs sentences).
   */
  ttsMode: TtsMode;
  /** PubSub listener on the conversation channel (removed on cleanup). */
  listener: ChannelMessageListener;
  /**
   * A TTS stream is open OR its delivered audio is still sounding on the
   * client (F5h): true from the stream's first chunk until the client's
   * playback_ended frame (queue drained — the audio STOPPED sounding) or
   * the safety timeout. The provider's onEnd (send-end) no longer clears
   * it — with streaming TTS the client holds seconds of buffered audio
   * past send-end, and the barge-in window must cover all of it.
   */
  ttsActive: boolean;
  /**
   * Playback safety timeout (F5h): armed at the provider's onEnd (send-end)
   * so the armed state cannot hang if the client never sends playback_ended
   * (old client without the protocol, WebAudio unavailable, tab frozen).
   * Duration: the full delivered audio (ttsTotalMs) + drain margin — worst
   * case, nothing has sounded yet. Cleared on playback_ended, barge-in, new
   * turn, stream open and cleanup. Its being armed is also the guard that
   * separates the current send-epoch's playback_ended from stale frames.
   */
  playbackSafetyTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Barge-in freeze (REQ-4, F1b): the turn that opened the current/last TTS
   * stream was interrupted — its late text_chunk broadcasts must NOT open a
   * new TTS stream (never two audios at once; the interrupting utterance's
   * own turn resets this when it opens its stream).
   */
  turnFrozen: boolean;
  /**
   * Tombstone (REQ-4, F1b): messageId of the turn that was interrupted. Its
   * late text_chunk broadcasts are dead forever — even after the freeze is
   * lifted for the interrupting utterance's turn, the OLD turn's chunks
   * must never open a TTS stream again (never two audios at once).
   */
  frozenMessageId: string | null;
  /** messageId of the assistant text message currently being spoken. */
  turnSpokenMessageId: string | null;
  /**
   * Barge-in context note (REQ-4, F1b): what the user actually heard of the
   * interrupted response. Stashed by handleBargeIn, consumed (and cleared)
   * by the next agent turn's prompt so the model knows what was heard and
   * does not repeat the unheard part.
   */
  pendingBargeInContext: string | null;
  /**
   * Playback position tracking (REQ-4, F1b): assistant text fed to the TTS
   * for the current turn, in feed order. On barge-in, the proportion
   * playbackPositionMs / ttsTotalMs estimates how much of it the user heard.
   */
  turnSpokenText: string;
  /** Total ms of audio the TTS delivered for the current turn (chunk count × CHUNK_MS). */
  ttsTotalMs: number;
  /**
   * PoC 2026-10-31 — alignment of the current turn's audio: every character
   * the TTS has synthesized so far (in text order) with its ABSOLUTE start
   * (ms from the turn's first audio). Built from the per-segment alignment
   * the stream-input provider reports; empty on the sentence provider.
   */
  turnAlignmentChars: string[];
  turnAlignmentStarts: number[];
  /** Ms of audio synthesized so far this turn (sum of segment durations). */
  turnAudioMs: number;
  /**
   * Last playback position (ms) registered by a barge-in — what the user
   * actually heard of the interrupted response. Exposed for tests/UI.
   */
  lastPlaybackPositionMs: number | null;
  /** Latency instrumentation (AC): STT-final → first TTS audio, per turn. */
  sttFinalAt: number | null;
  firstTtsAudioAt: number | null;
  lastLatencyMs: number | null;
  /** Latency budget trace for the in-flight turn (F1b, NFR-1). */
  latencyTrace: TurnLatencyTrace | null;
  /** PoC trace: the last turn's trace, kept past send-end so the client's playback marks land on it. */
  lastTurnTrace: TurnLatencyTrace | null;
  /**
   * Gate dialogue state (F2a, REQ-7 layer 2): whether the agent's last turn
   * just completed, and whether THIS utterance barged into the agent's speech.
   */
  gateDialogue: GateDialogueState;
  /** Gate layer that opened the CURRENT turn ('vocative' | 'context' | …) — the dialogue window only follows a 'vocative' turn. */
  lastActivationLayer: string | null;
  /**
   * Layer-3 context note (F2a, REQ-7): rides the FIRST agent turn after
   * connect or a mode change so the LLM knows it is in a voice session.
   */
  pendingVoiceContext: string | null;
  /**
   * Overheard session memory (F2b, REQ-9 — decisión de Pablo #5): the recent
   * utterances heard but not addressed to the agent (passive, or
   * non-response-worthy in conversation). They are already visible-tenue in
   * the thread (source:'voice', overheard:true — channel_messages) AND
   * mirrored into session_messages as they are heard
   * (persistOverheardToSessionStore) so every subsequent turn's LLM context —
   * voice or text — carries them. This buffer additionally makes them
   * CONSULTABLE as one inline note: when a turn activates after accumulated
   * overheard, the buffer rides the turn as context so the agent can answer
   * "Alice, ¿qué hemos hablado?" without re-reading the channel. Cleared
   * after riding a turn (the LLM history keeps them from there on).
   */
  overheardBuffer: string[];
  /**
   * pause_listening timer (REQ-8, F2b): the pending auto-return to
   * `conversation` when a pause elapses. Null when no pause is active.
   * Cleared on any later mode change (a door that opened overrides the
   * pause) and on cleanup.
   */
  pauseTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Filler enabled for this connection (F5b, flag voice.filler, default
   * off): resolved once at handshake like ttsMode. When true, an activated
   * turn whose first LLM chunk takes longer than FILLER_GRACE_MS plays the
   * pre-generated filler MP3 (see FILLER_GRACE_MS for the timing contract).
   */
  fillerEnabled: boolean;
  /**
   * Pending filler timer (F5b): armed in handleFinalTranscript when the
   * turn activates, disarmed by the first LLM text chunk (the channel
   * listener) or fired (the gap was real — play the filler). Null when no
   * timer is armed. Cleared on barge-in, turn end and cleanup.
   */
  fillerTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Whether the filler is CURRENTLY playing (F5b): true between the filler's
   * speaking_started and its speaking_ended. The first real LLM chunk that
   * arrives while it sounds does NOT open the TTS stream until the filler
   * has finished (never two audios at once) — the chunks buffer via the
   * normal ttsActive=false path and the stream opens on the filler's end.
   */
  fillerPlaying: boolean;
  /**
   * Per-session health telemetry (F4, REQ-11/UC-12): duration, turns,
   * overheard, barge-ins, audio drops, reconnects. Snapshotted to the
   * `voice_telemetry_sessions` collection at close (and on the periodic
   * flush) — "what happens inside voice when nobody is watching".
   */
  sessionTelemetry: VoiceSessionTelemetry;
}

/** Injectable provider factories (tests mock these; prod uses the defaults). */
export interface VoiceLoopProviderFactories {
  sttFactory?: (secretsManager: SecretsManager) => IStreamingTranscriptionProvider;
  ttsFactory?: (secretsManager: SecretsManager) => ITtsProvider;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Audio duration of one TTS chunk frame sent to the client (ms). The
 * ElevenLabsFlashTtsProvider slices audio into ~3KB base64 frames of
 * mp3_44100_128 (~0.19 s of audio each). Used to estimate how much of the
 * response was actually heard at a given playback position (REQ-4).
 */
const TTS_CHUNK_MS = 190;
/** Dialogue window after an answered invocation in passive (Pablo, PoC 2026-10-31). */
/**
 * PoC 2026-10-31, round 5 (Pablo: "en el periodo del cambio es como si
 * estuviera en modo conversando… tarda mucho hasta que vuelve a su modo"):
 * the window is SHORT, opens only after a turn the user opened BY NAME, is
 * armed only from the client's real end of playback, never re-arms after a
 * follow-up that came through it, and a closure phrase shuts it at once.
 */
const DIALOGUE_WINDOW_MS = 5000;

/**
 * Playback safety margin (F5h): slack added to ttsTotalMs when arming the
 * playback safety timeout at the provider's onEnd — client decode + drain
 * lag on top of the delivered audio duration.
 */
const PLAYBACK_SAFETY_MARGIN_MS = 1500;

/**
 * Cap of the overheard session-memory buffer (F2b, REQ-9). The buffer rides
 * the next activated turn as context; beyond this the oldest lines drop
 * (they stay in the channel history AND in session_messages via
 * persistOverheardToSessionStore, so nothing is lost — only the inline
 * context note stays bounded).
 */
const OVERHEARD_BUFFER_MAX = 20;

/**
 * Reconnect window (F4, NFR-3 evidence): a new connection to a channel whose
 * voice session was live (`presence: 'on'`) or active within this window
 * counts as a RECONNECT (the session resumed), not a fresh activation. A
 * connection the next morning (lastActivityAt hours old) is a fresh session.
 */
const RECONNECT_WINDOW_MS = 5 * 60_000;

/**
 * Filler grace window (F5b): how long after STT-final the loop waits for the
 * first LLM text chunk before playing the pre-generated filler. If the chunk
 * lands within this window, NOTHING plays — the filler only covers the REAL
 * gap, it never competes with a fast first chunk. ~400ms: fast-leg TTFT
 * (voice.llm=fast) lands well under it, so with F5a active the filler stays
 * silent on healthy turns and only speaks when the LLM is genuinely slow.
 */
const FILLER_GRACE_MS = 400;

// ============================================================================
// VOICE LOOP
// ============================================================================

export class VoiceLoop {
  private connections: Map<string, VoiceLoopConnection> = new Map();
  private pubSubService?: PubSubService;
  /** LLM context store (session_messages) — see setSessionStore. */
  private sessionStore?: SessionStore;
  private authService: AuthService;
  private sttFactory: (secretsManager: SecretsManager) => IStreamingTranscriptionProvider;
  private ttsFactory: (secretsManager: SecretsManager) => ITtsProvider;
  /** Latency budget across all turns of this backend instance (F1b, NFR-1). */
  private latencyBudget = new VoiceLoopLatencyBudget();
  /** Gate decision telemetry across all connections (F2a, REQ-11/UC-12). */
  private gateTelemetry = new VoiceGateTelemetry();
  /**
   * Session telemetry flush interval (F4, REQ-11): open sessions persist a
   * live snapshot every 60 s so a backend crash does not lose the record of
   * an in-flight session (closed sessions flush at cleanup — always).
   */
  private telemetryFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Injectable clock (tests drive determinism; prod Date.now). */
  private clock: () => number = Date.now;

  constructor(
    private db: Db,
    private channelManager: ChannelManager,
    private secretsManager: SecretsManager,
    private messageHandler: MessageHandler,
    private workspaceService: WorkspaceService | null = null,
    private featureFlagService: FeatureFlagService | null = null,
    authService?: AuthService,
    factories: VoiceLoopProviderFactories = {},
  ) {
    this.authService = authService ?? new AuthService(db);
    this.sttFactory =
      factories.sttFactory ??
      ((secrets) => {
        const key = secrets.system('deepgram')?.apiKey;
        return new DeepgramStreamingTranscriptionProvider({ apiKey: key });
      });
    this.ttsFactory =
      factories.ttsFactory ??
      ((secrets) => {
        const key = secrets.system('elevenlabs')?.apiKey;
        return new ElevenLabsFlashTtsProvider({ apiKey: key });
      });
  }

  setPubSubService(pubSubService: PubSubService): void {
    this.pubSubService = pubSubService;
  }

  /**
   * Wire in the SessionStore (session_messages) — the LLM context store.
   * Overheard utterances (REQ-9) persist to channel_messages for the UI, but
   * the LLM context is built from session_messages (getMessagesForLLM), so
   * without this store the overheard lines are invisible to every turn that
   * did not personally carry them (text turns after a voice session, or voice
   * turns after the buffer was capped). server-bootstrap calls this right
   * after construction (voice-loop-session-store-wiring.test.ts pins it —
   * the first version of this setter shipped UNWIRED and the mirror silently
   * no-oped in production for half a day).
   */
  setSessionStore(sessionStore: SessionStore): void {
    this.sessionStore = sessionStore;
  }

  // ---------------------------------------------------------------------------
  // TTS STRATEGY (F5d — flag voice.tts: 'sentences' default | 'stream')
  // ---------------------------------------------------------------------------

  /**
   * Resolve the TTS strategy for a connection (F5d). 'sentences' (the flag
   * default, and any resolution failure) = zero change — the sentence
   * provider. 'stream' = the ElevenLabs stream-input WebSocket.
   */
  private async resolveTtsMode(userId: string, workspaceId: string): Promise<TtsMode> {
    if (!this.featureFlagService) return 'sentences';
    try {
      const flag = await this.featureFlagService.resolve('voice.tts', { userId, workspaceId });
      return flag === 'stream' ? 'stream' : 'sentences';
    } catch (err) {
      // A broken flag must never break the voice session (F5a pattern).
      console.warn('[VoiceLoop] voice.tts flag resolution failed — keeping sentences TTS:', err);
      return 'sentences';
    }
  }

  /**
   * Resolve the endpointing threshold for a connection (F5b, flag
   * voice.endpointing-ms, default 200). This is the ms of silence Deepgram
   * waits before closing the user's utterance — the perceived "does it let
   * me finish?" knob. Clamped to a sane range (100–1000): a typo'd flag
   * value must not produce an absurd Deepgram param. Resolution failure →
   * the 200ms default (a broken flag must never break the session).
   */
  private async resolveEndpointingMs(userId: string, workspaceId: string): Promise<number> {
    const fallback = 200;
    if (!this.featureFlagService) return fallback;
    try {
      const flag = await this.featureFlagService.resolve('voice.endpointing-ms', { userId, workspaceId });
      const value = typeof flag === 'number' ? flag : Number(flag);
      if (!Number.isFinite(value)) return fallback;
      return Math.min(1000, Math.max(100, Math.round(value)));
    } catch (err) {
      console.warn('[VoiceLoop] voice.endpointing-ms flag resolution failed — keeping 200ms:', err);
      return fallback;
    }
  }

  /**
   * Resolve the filler switch for a connection (F5b, flag voice.filler,
   * default off). Off = zero change — the pre-F5b dead silence while the
   * first LLM chunk arrives. Resolution failure → off (a broken flag must
   * never break the session; silence is the safe degradation).
   */
  private async resolveFillerEnabled(userId: string, workspaceId: string): Promise<boolean> {
    if (!this.featureFlagService) return false;
    try {
      const flag = await this.featureFlagService.resolve('voice.filler', { userId, workspaceId });
      return flag === true;
    } catch (err) {
      console.warn('[VoiceLoop] voice.filler flag resolution failed — filler stays off:', err);
      return false;
    }
  }

  /**
   * Build the TTS provider for a connection (F5d). 'sentences' goes through
   * the injectable ttsFactory (tests/legacy path — unchanged); 'stream' uses
   * the stream-input WS provider, which carries its own sentence fallback
   * if the WS fails. The stream provider resolves the same secret.
   */
  private buildTtsProvider(mode: TtsMode): ITtsProvider {
    if (mode === 'stream') {
      // Optional-chain: a missing/unavailable secret must not kill the
      // connection — the provider reports onError cleanly instead (and
      // its own sentence fallback still applies).
      const key = this.secretsManager?.system?.('elevenlabs')?.apiKey;
      return new ElevenLabsStreamTtsProvider({ apiKey: key });
    }
    return this.ttsFactory(this.secretsManager);
  }

  // ---------------------------------------------------------------------------
  // CONNECTION LIFECYCLE (mirrors the legacy handler's F0 contract)
  // ---------------------------------------------------------------------------

  async handleConnection(
    clientWs: WebSocket,
    sessionId: string,
    agentId: string,
    existingChannelId?: string,
    chatChannelId?: string,
    requestedMode?: string,
  ): Promise<void> {
    const connectionId = `voiceloop_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      // 1. Authenticate (session token or tak: API token — same as legacy).
      const userId = await this.authenticateUser(sessionId);
      if (!userId) {
        this.sendToClient(clientWs, { type: 'error', code: 'auth', message: 'Authentication failed' });
        clientWs.close();
        return;
      }

      console.log(`[VoiceLoop] New connection: ${connectionId} user=${userId} agent=${agentId}`);

      // 2. Resolve workspaceId (chatChannel > existingChannel > agent doc).
      let workspaceId: string | undefined;
      if (chatChannelId) {
        workspaceId = (await this.channelManager.getChannel(chatChannelId) as any)?.workspaceId;
      }
      if (!workspaceId && existingChannelId) {
        workspaceId = (await this.channelManager.getChannel(existingChannelId) as any)?.workspaceId;
      }
      if (!workspaceId) {
        const agentDoc = await this.db.collection('agents').findOne({ agentId });
        workspaceId = (agentDoc as any)?.workspaceId || undefined;
      }
      if (!workspaceId) {
        this.sendToClient(clientWs, { type: 'error', code: 'workspace_unresolved', message: 'Could not resolve workspace for voice session' });
        clientWs.close();
        return;
      }

      // SEC-2: same cross-tenant gate as channel.create (agentId is client-supplied).
      await assertCanCreateChannel(this.db, this.workspaceService, userId, workspaceId, agentId);

      // 3. Resolve the single conversation channel (F0, REQ-2):
      //    chatChannelId > existingChannelId (resume) > typed rejection.
      //    No orphan voice channels are ever created.
      const candidateId = chatChannelId || existingChannelId;
      let conversationChannelId: string;
      let isResuming = false;
      if (candidateId) {
        const candidate = await this.channelManager.getChannel(candidateId);
        if (candidate && (candidate as any).userId === userId) {
          conversationChannelId = candidateId;
          isResuming = true;
        } else {
          this.sendToClient(clientWs, {
            type: 'error',
            code: 'channel_unavailable',
            message: 'The conversation channel for this voice session was not found or is not yours. Reopen the chat and try again.',
          });
          clientWs.close();
          return;
        }
      } else {
        this.sendToClient(clientWs, {
          type: 'error',
          code: 'channel_required',
          message: 'A chatChannelId is required for voice sessions (voice lives in the conversation channel).',
        });
        clientWs.close();
        return;
      }

      // 4. Agent display name (vocative gate wake word).
      const agent = await this.db.collection('agents').findOne({ agentId });
      const agentName = agent?.name || 'Assistant';

      // 5. Prior voice-session record (REQ-6: mode survives reconnections).
      //    F4: the full record (not just the mode) also classifies this
      //    connection as a RECONNECT vs a fresh activation.
      const priorRecord = await this.loadVoiceSessionRecord(conversationChannelId, agentId);
      const persistedMode: VoiceMode | null =
        priorRecord?.mode === 'conversation' || priorRecord?.mode === 'passive' || priorRecord?.mode === 'available'
          ? priorRecord.mode
          : null;
      // The opening door may ask for the starting mode (PoC 2026-10-31: the
      // navbar presence opens in 'available'); it wins over the persisted one.
      const requested: VoiceMode | null =
        requestedMode === 'conversation' || requestedMode === 'passive' || requestedMode === 'available'
          ? requestedMode
          : null;
      const mode: VoiceMode = requested ?? persistedMode ?? 'conversation';
      // Reconnect (NFR-3 evidence): the prior session was still live
      // (`presence: 'on'`) or was active within the reconnect window — this
      // connection resumes it. A record from hours ago is a fresh session.
      const priorActivityAt = priorRecord?.lastActivityAt ? new Date(priorRecord.lastActivityAt).getTime() : null;
      const isReconnect =
        priorRecord != null &&
        (priorRecord.presence === 'on' ||
          (priorActivityAt != null && !Number.isNaN(priorActivityAt) && this.clock() - priorActivityAt < RECONNECT_WINDOW_MS));

      // 6. Build the connection with its STT/TTS providers.
      //    F5d: the TTS strategy is resolved per connection from the
      //    `voice.tts` flag — 'sentences' (default) = the sentence provider
      //    (zero change); 'stream' = the ElevenLabs stream-input WS (first
      //    audio at ~50 chars, with automatic fallback to sentences if the
      //    WS fails). Flag resolution failures degrade to 'sentences' — a
      //    broken flag must never break the voice session.
      const stt = this.sttFactory(this.secretsManager);
      const ttsMode = await this.resolveTtsMode(userId, workspaceId);
      const tts = this.buildTtsProvider(ttsMode);
      // F5b perception flags, resolved per connection like ttsMode:
      //   endpointingMs — the silence threshold that closes the user's
      //     utterance (300ms hardcoded pre-F5b; 200ms default now, Deepgram's
      //     conversational guidance). Passed to the STT connect config — the
      //     provider's own config still wins when set explicitly (tunable
      //     intact: provider config > flag > provider default).
      //   fillerEnabled — the pre-generated "Mmm." while the first LLM chunk
      //     is late (default off; see handleFinalTranscript for the timing).
      const endpointingMs = await this.resolveEndpointingMs(userId, workspaceId);
      const fillerEnabled = await this.resolveFillerEnabled(userId, workspaceId);
      const connection: VoiceLoopConnection = {
        clientWs,
        userId,
        workspaceId,
        channelId: conversationChannelId,
        agentId,
        sessionId,
        agentName,
        mode,
        stt,
        tts,
        ttsMode,
        listener: () => {}, // wired below
        ttsActive: false,
        playbackSafetyTimer: null,
        turnFrozen: false,
        frozenMessageId: null,
        turnSpokenMessageId: null,
        pendingBargeInContext: null,
        turnSpokenText: '',
        ttsTotalMs: 0,
        turnAlignmentChars: [],
        turnAlignmentStarts: [],
        turnAudioMs: 0,
        lastPlaybackPositionMs: null,
        sttFinalAt: null,
        firstTtsAudioAt: null,
        lastLatencyMs: null,
        latencyTrace: null,
        lastTurnTrace: null,
        gateDialogue: { agentJustSpoke: false, interruptedAgentSpeech: false, dialogueWindowUntil: null },
        lastActivationLayer: null,
        pendingVoiceContext: buildVoiceTurnContext(mode),
        overheardBuffer: [],
        pauseTimer: null,
        fillerEnabled,
        fillerTimer: null,
        fillerPlaying: false,
        sessionTelemetry: new VoiceSessionTelemetry(
          conversationChannelId, agentId, userId, mode, () => this.clock(),
        ),
      };
      this.connections.set(connectionId, connection);
      // A real resume (prior session live/active) is a reconnect (NFR-3 evidence, F4).
      if (isReconnect) connection.sessionTelemetry.recordReconnect();

      // 7. Persistent session record (REQ-6).
      await this.upsertVoiceSession(connection);

      // 8. STT streaming — interim to the frontend, final into the pipeline.
      //    onSpeechStart (VAD, F1b REQ-4): the user starts speaking while the
      //    TTS is talking → immediate barge-in, no transcript needed.
      await stt.connect(
        {
          onInterim: (text) => {
            this.sendToClient(connection.clientWs, {
              type: 'transcript', text, isUser: true, partial: true,
            });
          },
          onSpeechStart: () => {
            const conn = this.connections.get(connectionId);
            if (!conn) return;
            // Barge-in only while OUR audio is in flight (speaking). The
            // playback position at this instant: everything delivered so far.
            if (conn.ttsActive || conn.turnFrozen) {
              this.handleBargeIn(connectionId, conn.ttsTotalMs, 'vad');
            }
          },
          onFinal: (text) => {
            this.handleFinalTranscript(connectionId, text).catch((err) => {
              console.error('[VoiceLoop] Error handling final transcript:', err);
              this.sendToClient(connection.clientWs, {
                type: 'error', code: 'server_error', message: 'Failed to process the spoken turn.',
              });
            });
          },
          onError: (err) => {
            console.error('[VoiceLoop] STT error:', err.message);
            // Audio drop, not session death (F4 robustez): the session keeps
            // living — the client shows the typed error and can keep writing
            // text; the next utterance retries through the same STT socket.
            this.connections.get(connectionId)?.sessionTelemetry.recordSttError();
            this.sendToClient(connection.clientWs, {
              type: 'error', code: 'stt_error', message: err.message,
            });
          },
        },
        {
          languageCode: 'es',
          // F5b: endpointing via the voice.endpointing-ms flag (default
          // 200ms — was 300ms hardcoded). The provider's own config still
          // wins when set (config?.endpointingMs ?? provider config ?? 300),
          // so the F1b tunable is intact — this only feeds the per-connect
          // config layer, which the provider treats as the first choice.
          endpointingMs,
          vocabulary: null,
        },
      );

      // 9. Channel listener — taps the agent turn's broadcasts for TTS.
      connection.listener = this.makeChannelListener(connectionId);
      this.pubSubService?.addListener(conversationChannelId, connection.listener);

      // 10. Client frame routing.
      this.setupClientHandlers(connectionId);

      // 11. Notify the client of the session channel + hydrate history.
      const historicTranscripts = await this.loadHistoricTranscripts(conversationChannelId);
      this.sendToClient(clientWs, {
        type: 'voice_channel',
        channelId: conversationChannelId,
        isResuming,
        historicTranscripts: historicTranscripts.length > 0 ? historicTranscripts : undefined,
      });

      console.log(`[VoiceLoop] Session ready: channel=${conversationChannelId} mode=${mode}`);
      this.ensureTelemetryFlushTimer();
    } catch (error) {
      console.error('[VoiceLoop] Connection error:', error);
      const errMsg = (error as Error).message || 'Connection failed';
      const errorCode = errMsg.includes('Deepgram') ? 'stt_error' : 'unknown';
      this.sendToClient(clientWs, { type: 'error', code: errorCode, message: errMsg });
      setTimeout(() => {
        clientWs.close();
        this.connections.delete(connectionId);
      }, 100);
    }
  }

  // ---------------------------------------------------------------------------
  // CLIENT FRAMES
  // ---------------------------------------------------------------------------

  private setupClientHandlers(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const { clientWs } = connection;

    clientWs.on('message', (data: Buffer) => {
      const connection = this.connections.get(connectionId);
      if (!connection) return;
      try {
        const raw = data.toString();

        // Current frontend shape: { user_audio_chunk: "<base64>" } (no type
        // field). v2 contract shape: { type: 'user_audio_chunk', audio_base_64 }.
        // Accept both — the frontend migrates to the contract in F3.
        try {
          const asObj = JSON.parse(raw);
          if (asObj && typeof asObj.user_audio_chunk === 'string') {
            connection.stt.sendAudio(asObj.user_audio_chunk);
            return;
          }
        } catch { /* fall through to the typed-frame parser */ }

        const frame = parseVoiceLoopClientFrame(raw);
        if (!frame) return;

        switch (frame.type) {
          case 'user_audio_chunk':
            connection.stt.sendAudio(frame.audio_base_64);
            break;
          case 'set_mode':
            this.handleSetMode(connectionId, frame.mode, 'ui');
            break;
          case 'interrupt':
            // Barge-in (REQ-4): client-side cut with the client's authoritative
            // playback position (what the user actually heard, ms into the
            // response audio). Cancels the TTS + truncates the pending queue.
            this.handleBargeIn(connectionId, frame.playbackPositionMs, 'client');
            break;
          case 'playback_ended':
            // F5h: the client's playback queue drained — the turn's audio
            // STOPPED sounding. The true end of the barge-in window: ttsActive
            // drops here (the provider's onEnd only closed the send side).
            this.handlePlaybackEnded(connectionId);
            break;
          case 'playback_position':
            this.handlePlaybackPosition(connectionId, Number(frame.positionMs));
            break;
          case 'playback_started': {
            // PoC trace: the first TTS buffer started sounding on the client —
            // the instant the user actually hears the answer.
            const trace = connection.latencyTrace ?? connection.lastTurnTrace;
            if (trace) {
              trace.markPlaybackStarted();
              this.emitTrace(connection, 'playback_started');
            }
            break;
          }
          case 'ping':
            this.sendToClient(connection.clientWs, { type: 'pong', event_id: frame.event_id });
            break;
          case 'pong':
            break; // keepalive reply — nothing to do
          default:
            break;
        }
      } catch { /* non-JSON from client — ignore */ }
    });

    clientWs.on('close', () => {
      console.log(`[VoiceLoop] Client disconnected: ${connectionId}`);
      this.cleanup(connectionId);
    });

    clientWs.on('error', (err) => {
      console.error(`[VoiceLoop] Client error: ${connectionId}`, err);
      this.cleanup(connectionId);
    });
  }

  /**
   * Open (openMs > 0) or close (null) the dialogue window and tell the client,
   * which paints it as a transient "Conversando" with a draining bar (Pablo,
   * PoC 2026-10-31: "que se vea en qué modo estás aunque sea temporal").
   */
  private setDialogueWindow(connection: VoiceLoopConnection, openMs: number | null): void {
    const wasOpen = connection.gateDialogue.dialogueWindowUntil != null;
    connection.gateDialogue.dialogueWindowUntil = openMs ? Date.now() + openMs : null;
    if (openMs) this.sendToClient(connection.clientWs, { type: 'dialogue_window', openMs });
    else if (wasOpen) this.sendToClient(connection.clientWs, { type: 'dialogue_window', openMs: 0 });
  }

  /** set_mode (UI picker door) — validates, persists, broadcasts mode_changed. */
  private handleSetMode(connectionId: string, mode: VoiceMode, source: 'ui' | 'system'): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (mode !== 'conversation' && mode !== 'passive' && mode !== 'available') {
      this.sendToClient(connection.clientWs, {
        type: 'error', code: 'bad_request', message: `Unknown mode '${mode}'.`,
      });
      return;
    }
    this.applyModeCommand(connectionId, { mode, ack: '', pattern: 'ui' }, source);
  }

  /**
   * Apply a mode change from ANY door (voice command, UI picker, agent tool —
   * REQ-6: "una puerta de voz, una puerta de UI, un mismo estado"). Validates,
   * sets the connection mode, re-arms the layer-3 context note, resets the
   * dialogue state, persists to voice_sessions, and broadcasts `mode_changed`
   * to the client. The spoken ack (when any — voice/agent doors) plays via
   * TTS so the ceremony is audible, not just visible (UX §5.1/§5.2).
   */
  private applyModeCommand(
    connectionId: string,
    command: { mode: VoiceMode; ack: string; pattern?: string },
    source: 'voice' | 'ui' | 'system',
  ): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const { mode, ack } = command;
    if (mode !== 'conversation' && mode !== 'passive' && mode !== 'available') {
      this.sendToClient(connection.clientWs, {
        type: 'error', code: 'bad_request', message: `Unknown mode '${mode}'.`,
      });
      return;
    }
    connection.mode = mode;
    // Session telemetry (F4, REQ-11): one mode change through any door.
    connection.sessionTelemetry.recordModeChange(mode);
    // A door that opened overrides any pending pause (REQ-8): the user (or
    // the agent) changed the mode — the auto-return timer is dead.
    if (connection.pauseTimer) {
      clearTimeout(connection.pauseTimer);
      connection.pauseTimer = null;
    }
    // Layer-3 context note (F2a, REQ-7): the mode change re-arms the
    // voice-session note so the NEXT agent turn knows the new mode.
    connection.pendingVoiceContext = buildVoiceTurnContext(mode);
    // Mode change resets the dialogue state — the classifier's "agent just
    // spoke" boost must not leak across a mode switch.
    connection.gateDialogue.agentJustSpoke = false;
    connection.gateDialogue.interruptedAgentSpeech = false;
    // Any mode change closes the dialogue window — including the agent's own
    // set_mode('passive') after a "vale, gracias" (Pablo, PoC 2026-10-31).
    this.setDialogueWindow(connection, null);
    // …and the spoken ack ("Vale.") that follows must NOT open one when its
    // playback ends: the last turn's 'vocative' layer is spent (round 6 — an
    // ack re-armed the window and an unaddressed line got answered).
    connection.lastActivationLayer = null;
    this.touchVoiceSession(connection).catch(() => {});
    this.sendToClient(connection.clientWs, { type: 'mode_changed', mode, source });

    // Spoken ack (UX §5.1/§5.2 — "Vale." / "Dime." / "Aquí estoy."): the
    // minimum viable confirmation, spoken via TTS so a mode change is never
    // silent (a change you cannot hear is a change you did not notice). The
    // UI door sends none — its ceremony is the picker itself (UX §2.3: the
    // same state, two doors, each with its own native ceremony).
    if (ack && source !== 'ui') {
      this.speakAck(connectionId, ack);
    }

    console.log(`[VoiceLoop] Mode changed to '${mode}' (${source}) for channel ${connection.channelId}`);
  }

  /**
   * Speak a short ack ("Vale.") through the TTS stream — the mode-change
   * ceremony's audible half. Opens the stream if none is active (a mode
   * command never has an agent turn to piggyback on) and drains it: the
   * ack is a complete sentence, so endOfText fires immediately.
   */
  private speakAck(connectionId: string, ack: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (!connection.tts.isSpeaking()) {
      // F5h: the provider's state opens the stream (ttsActive stays armed
      // through the playback window) — an ack during that window still
      // speaks, exactly as before. The superseded epoch's safety timer
      // dies here; this epoch arms its own at its onEnd.
      if (connection.playbackSafetyTimer) {
        clearTimeout(connection.playbackSafetyTimer);
        connection.playbackSafetyTimer = null;
      }
      connection.ttsActive = true;
      connection.turnSpokenMessageId = null; // not an agent turn — no tombstone
      connection.tts.speak(this.makeTtsCallbacks(connectionId));
    }
    connection.tts.feed(ack);
    connection.tts.endOfText();
  }

  // ---------------------------------------------------------------------------
  // BARGE-IN (REQ-4, F1b) — cancel TTS + register playback position
  // ---------------------------------------------------------------------------

  /**
   * Barge-in: the user cuts the agent's speech mid-response. Immediate and
   * idempotent — a second trigger while already cut is a no-op (the client
   * VAD and the server VAD can both fire for the same interruption).
   *
   * Effects, in order:
   *  1. `tts.cancel()` — kills the in-flight synthesis request (AbortController)
   *     and drops the pending sentence queue (~0 perceived cut, AC-5 <300ms).
   *  2. `turnFrozen = true` — late text_chunk broadcasts of the interrupted
   *     turn must NOT open a new TTS stream (never two audios at once). The
   *     interrupting utterance's own turn clears the freeze.
   *  3. Playback position registered: `playbackPositionMs` (client frame:
   *     authoritative — the client knows what it actually played; server VAD:
   *     estimated as everything delivered so far). Kept on the connection
   *     (`lastPlaybackPositionMs`) and persisted as a visible context line
   *     with the estimated heard text, so the conversation history reflects
   *     only what the user actually heard (REQ-4: historial truncado a lo oído).
   *  4. Latency budget: the interrupted turn is recorded as a barge-in turn.
   *
   * The interrupting utterance itself flows through the normal STT final →
   * handleFinalTranscript path; the text pipeline's boundary_aware interrupt
   * strategy gives it priority over the old turn at the next boundary.
   */
  private handleBargeIn(
    connectionId: string,
    playbackPositionMs: number,
    source: 'client' | 'vad',
  ): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    // Idempotent: already cut for this turn — nothing left to cancel.
    if (connection.turnFrozen) return;

    const positionMs = Math.max(0, Math.min(playbackPositionMs, connection.ttsTotalMs));
    connection.lastPlaybackPositionMs = positionMs;
    connection.turnFrozen = true;
    const bargeTrace = connection.latencyTrace ?? connection.lastTurnTrace;
    if (bargeTrace) {
      bargeTrace.markBargeIn();
      this.emitTrace(connection, `barge_in_${source}`);
    }
    // F5b: a barge-in kills any pending filler timer too — the user is
    // already talking; a filler now would be talking over them.
    if (connection.fillerTimer) {
      clearTimeout(connection.fillerTimer);
      connection.fillerTimer = null;
    }
    connection.fillerPlaying = false;
    // Session telemetry (F4, REQ-11): one barge-in, by trigger path.
    connection.sessionTelemetry.recordBargeIn(source === 'client' ? 'client' : 'vad');
    // Dialogue state (F2a, REQ-7 layer 2): the next utterance interrupted the
    // agent's speech — interrupting someone is inherently addressing them.
    connection.gateDialogue.interruptedAgentSpeech = true;

    // 1. Kill the audio: in-flight request + pending queue.
    if (connection.ttsActive) {
      connection.tts.cancel();
      connection.ttsActive = false;
    }
    // F5h: a barge-in is a cut, not a drain — the playback safety timer is
    // moot (ttsActive is already false; the client stopped() on the interrupt
    // echo and will never fire its drain edge for this turn).
    if (connection.playbackSafetyTimer) {
      clearTimeout(connection.playbackSafetyTimer);
      connection.playbackSafetyTimer = null;
    }

    // Tombstone: the interrupted turn's messageId is dead forever (REQ-4).
    connection.frozenMessageId = connection.turnSpokenMessageId;
    connection.turnSpokenMessageId = null;

    // 2. Record the interrupted turn in the latency budget (REQ-11 rate).
    if (connection.latencyTrace) {
      this.latencyBudget.record(connection.latencyTrace, { bargeIn: true });
      connection.latencyTrace = null;
    }

    // 3. Playback position → conversation context (REQ-4): what the user
    //    actually heard. Estimate the heard text from the position proportion
    //    over the text fed to the TTS for this turn.
    const heardText = this.estimateHeardText(connection, positionMs);
    const contextLine = heardText
      ? `[El usuario interrumpió la respuesta hablada tras ~${Math.round(positionMs / 100) / 10}s de audio; oyó hasta: "${heardText}". No repitas lo no oído: responde a lo nuevo.]`
      : `[El usuario interrumpió la respuesta hablada de inmediato. No repitas lo no oído: responde a lo nuevo.]`;
    connection.pendingBargeInContext = contextLine;
    // The note is LLM context only — it rides the next turn's text. The visible
    // thread shows the cut INSIDE the interrupted reply (metadata.voice →
    // the unheard tail paints muted); no separate row (Pablo, PoC 2026-10-31:
    // the "Interrumpiste a … tras N s" event row "no me interesa").
    this.markCutOnMessage(connection, positionMs);

    // 4. Ack the cut to the client (authoritative position echoed back).
    this.sendToClient(connection.clientWs, {
      type: 'interrupt', playbackPositionMs: positionMs,
    });
    console.log(
      `[VoiceLoop] Barge-in (${source}) on channel ${connection.channelId}: cut at ${positionMs}ms of ${connection.ttsTotalMs}ms delivered`,
    );
  }

  /**
   * The client's playback truly ended (F5h): its queue drained after the
   * stream's speaking_ended — the turn's audio STOPPED sounding. This is
   * the real end of the barge-in window: ttsActive drops HERE, not at the
   * provider's onEnd (send-end — the client still holds seconds of
   * buffered audio then, and an interruption in that window must still
   * cut it).
   *
   * Stale-frame guard: only an armed safety timer means a send-epoch is
   * expecting a drain — a late duplicate (after a barge-in, a new turn or
   * a newer stream) must not clear the new state. The timer is cleared on
   * every path that supersedes the epoch, so armed ⟺ current window.
   */
  private handlePlaybackEnded(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (!connection.playbackSafetyTimer) return;
    clearTimeout(connection.playbackSafetyTimer);
    connection.playbackSafetyTimer = null;
    connection.ttsActive = false;
    console.log(
      `[VoiceLoop] Playback ended (client drain) on channel ${connection.channelId} — barge-in window closed`,
    );
    // Dialogue window (passive / available): the answer to a turn opened BY
    // NAME stopped sounding — the user has DIALOGUE_WINDOW_MS to follow up
    // without the name. One follow-up: a turn that came through the window
    // ('context' layer) does not open another.
    if (connection.mode !== 'conversation' && connection.lastActivationLayer === 'vocative') {
      this.setDialogueWindow(connection, DIALOGUE_WINDOW_MS);
    }
    const trace = connection.latencyTrace ?? connection.lastTurnTrace;
    if (trace) {
      trace.markPlaybackEnded();
      this.emitTrace(connection, 'turn_done');
    }
  }

  /** PoC instrumentation: one JSON line per turn event, parsed by .preview-voice/trace-report.mjs. */
  private emitTrace(connection: VoiceLoopConnection, event: string): void {
    const trace = connection.latencyTrace ?? connection.lastTurnTrace;
    if (!trace) return;
    console.log(
      `[VoiceTrace] ${JSON.stringify({ event, at: Date.now(), channel: connection.channelId, ...trace.toRecord() })}`,
    );
  }

  /**
   * Arm the playback safety timeout (F5h): the escape hatch that closes the
   * barge-in window when the client never reports playback_ended (old client
   * without the protocol, WebAudio unavailable, frozen tab). Duration: the
   * full delivered audio (ttsTotalMs) + drain margin — worst case nothing
   * has sounded yet when the provider finishes sending.
   */
  private armPlaybackSafetyTimer(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (connection.playbackSafetyTimer) {
      clearTimeout(connection.playbackSafetyTimer);
    }
    const timeoutMs = connection.ttsTotalMs + PLAYBACK_SAFETY_MARGIN_MS;
    connection.playbackSafetyTimer = setTimeout(() => {
      const conn = this.connections.get(connectionId);
      if (!conn) return;
      // The timer is cleared on every re-arm path (stream open, barge-in,
      // new turn, cleanup) — reaching here means this epoch never drained:
      // close the window the hard way.
      this.closePlaybackWindow(connectionId, `safety timeout (${timeoutMs}ms)`);
    }, timeoutMs);
  }

  /**
   * Close the barge-in playback window (F5h) — shared exit path for the
   * client drain (handlePlaybackEnded) and the safety timeout. Private;
   * tests drive the timeout path directly (deterministic — no timer
   * mocking in the harness, same as the F5b filler).
   */
  private closePlaybackWindow(connectionId: string, via: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (connection.playbackSafetyTimer) {
      clearTimeout(connection.playbackSafetyTimer);
      connection.playbackSafetyTimer = null;
    }
    connection.ttsActive = false;
    console.log(
      `[VoiceLoop] Playback window closed (${via}) on channel ${connection.channelId} — barge-in window closed`,
    );
  }

  /**
   * Estimate what the user heard of the interrupted response (REQ-4): the
   * playback position as a proportion of the delivered audio, applied to the
   * text fed to the TTS this turn. Character-proportional — crude but
   * conservative for context purposes (the alternative, sentence-level
   * mapping, needs per-sentence audio timing the provider doesn't expose).
   */
  private estimateHeardText(connection: VoiceLoopConnection, positionMs: number): string {
    return this.heardPrefix(connection, positionMs).text.trim();
  }

  /**
   * What the user heard up to `positionMs`: exact when the turn has alignment
   * (every character whose start ≤ position), proportional otherwise.
   * `chars` is the index into the fed text where the unheard tail begins.
   */
  private heardPrefix(connection: VoiceLoopConnection, positionMs: number): { text: string; chars: number; exact: boolean } {
    const starts = connection.turnAlignmentStarts;
    if (starts.length > 0) {
      let n = 0;
      while (n < starts.length && starts[n] <= positionMs) n++;
      return { text: connection.turnAlignmentChars.slice(0, n).join(''), chars: n, exact: true };
    }
    if (connection.ttsTotalMs <= 0 || !connection.turnSpokenText) return { text: '', chars: 0, exact: false };
    const ratio = Math.min(1, positionMs / connection.ttsTotalMs);
    const chars = Math.floor(connection.turnSpokenText.length * ratio);
    return { text: connection.turnSpokenText.slice(0, chars), chars, exact: false };
  }

  /**
   * Record the cut on the interrupted assistant message (metadata.voice) and
   * tell the client so its bubble paints the unheard tail muted (PoC).
   */
  private markCutOnMessage(connection: VoiceLoopConnection, positionMs: number): void {
    const messageId = connection.frozenMessageId;
    if (!messageId) return;
    const heard = this.heardPrefix(connection, positionMs);
    const voice = { interrupted: true, spokenChars: heard.chars, positionMs, exact: heard.exact };
    try {
      this.channelManager
        .updateMessageMetadataFields(messageId, { voice })
        .catch((err: unknown) => console.warn('[VoiceLoop] metadata.voice update failed:', err));
    } catch (err) {
      // Older channel managers / test doubles without the method: the mark is
      // best effort, the cut itself must never fail.
      console.warn('[VoiceLoop] metadata.voice update unavailable:', err);
    }
    this.sendToClient(connection.clientWs, { type: 'message_meta', messageId, metadata: { voice } });
  }

  // ---------------------------------------------------------------------------
  // THE BRAIN PATH — final transcript → Teros agent turn
  // ---------------------------------------------------------------------------

  private async handleFinalTranscript(connectionId: string, text: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    this.touchVoiceSession(connection).catch(() => {});

    // Spoken mode command (REQ-6, F2b — AC-3/AC-4b): "ponte en modo silencio"
    // / "hablemos" / "Alice, vuelve"… — a META-ORDER, not a conversation turn.
    // Detected BEFORE the invocation gate: in `conversation` everything is a
    // turn, but a mode order is addressed to the SESSION, not the agent — it
    // must switch the mode even when it would not survive the gate, and it
    // never spends an agent turn. The ack is spoken via TTS (UX §5.1/§5.2).
    const modeCommand = parseVoiceModeCommand(trimmed, connection.agentName, connection.mode);
    if (modeCommand) {
      this.applyModeCommand(connectionId, modeCommand, 'voice');
      return;
    }

    // Closure of the exchange while the dialogue window is open ("vale",
    // "gracias", "ya está"): the window shuts NOW and the phrase is not a
    // turn — it then follows the mode's normal path for an unaddressed line
    // (dropped in available, overheard in passive). Pablo, PoC 2026-10-31.
    if (
      connection.mode !== 'conversation' &&
      connection.gateDialogue.dialogueWindowUntil != null &&
      isClosurePhrase(trimmed)
    ) {
      this.setDialogueWindow(connection, null);
      console.log(`[VoiceLoop] Closure phrase ("${trimmed}") — dialogue window closed, no turn`);
    }

    // Invocation gate (REQ-7, F2a — 3 layers, spec order):
    //   1. vocative → ALL modes (the guaranteed ladder);
    //   2. a mention of the agent that is NOT a vocative → never fires (any mode);
    //   3. by mode: conversation → everything is a turn (layer 3, the LLM
    //      decides response-worthiness via the conversation context);
    //      attention → REMOVED with the mode itself (Pablo 2026-10-05);
    //      passive → the vocative is the only door.
    const decision: GateDecision = evaluateInvocationGate(
      trimmed,
      connection.mode,
      connection.agentName,
      connection.gateDialogue,
    );

    // Telemetry of the decision (REQ-11/UC-12): mode, layer, score, activated.
    this.gateTelemetry.record(connection.channelId, connection.agentId, decision, connection.mode);
    // Session telemetry (F4, REQ-11): one utterance evaluated in this mode.
    connection.sessionTelemetry.recordUtterance(connection.mode, decision.activated);

    // Dialogue state bookkeeping for the NEXT utterance's classifier: this
    // utterance is now the last thing said — the agent did not just speak.
    connection.gateDialogue.agentJustSpoke = false;
    connection.gateDialogue.interruptedAgentSpeech = false;
    // The window is consumed by this utterance (it re-opens only after the
    // answer to a turn opened by name finishes sounding).
    this.setDialogueWindow(connection, null);

    if (!decision.activated) {
      // Available ("Disponible", Pablo decision 1, PoC 2026-10-31): nothing
      // overheard is kept — no thread row, no session-store mirror, no
      // buffer. The utterance simply did not happen for the agent.
      if (connection.mode === 'available') return;
      // Overheard (REQ-9): persist to the history, visible-tenue client-side,
      // but no agent turn — silence costs nothing.
      await this.persistTranscript(connection, trimmed, true, true);
      this.sendToClient(connection.clientWs, {
        type: 'transcript', text: trimmed, isUser: true, overheard: true,
      });
      // Overheard → LLM context (session_messages), immediately. The context
      // of EVERY subsequent turn — voice or text — is built from
      // session_messages (getMessagesForLLM); without this write the line is
      // only visible-tenue in the UI and the agent loses the thread of what
      // was said around it (the reported bug: a text "Thanks" after a voice
      // session answered with no memory of the spoken meeting).
      this.persistOverheardToSessionStore(connection, trimmed).catch(() => {});
      // Session memory (F2b, REQ-9): the utterance joins the consultable
      // buffer — it rides the NEXT activated turn as context (the LLM then
      // keeps it in its own history), and it is already mirrored into
      // session_messages for every later turn's context. Capped so a long meeting does not
      // bloat the next turn's prompt (the channel history keeps the rest).
      connection.overheardBuffer.push(trimmed);
      if (connection.overheardBuffer.length > OVERHEARD_BUFFER_MAX) {
        connection.overheardBuffer.shift();
      }
      return;
    }

    // Persist the user transcript ONCE (source:'voice') + broadcast so the
    // chat UI sees the spoken turn in the unified thread.
    await this.persistTranscript(connection, trimmed, true, false);
    this.sendToClient(connection.clientWs, {
      type: 'transcript', text: trimmed, isUser: true,
    });

    // Which door opened this turn — the dialogue window only follows a turn
    // the user opened by NAME (a follow-up through the window never re-arms it).
    connection.lastActivationLayer = decision.layer;

    // Latency instrumentation (AC): STT-final → first TTS audio.
    connection.sttFinalAt = Date.now();
    connection.firstTtsAudioAt = null;
    connection.ttsActive = false;
    // F5h: a new turn supersedes any pending playback epoch — its safety
    // timer must not fire into the new turn's stream (the stream-open path
    // clears it too; this covers the no-stream edge).
    if (connection.playbackSafetyTimer) {
      clearTimeout(connection.playbackSafetyTimer);
      connection.playbackSafetyTimer = null;
    }

    // New turn: fresh TTS tracking (F1b). The freeze from a previous barge-in
    // is lifted — this utterance is the interrupting one (or the next turn
    // after a completed one); its text may open a new TTS stream.
    connection.turnFrozen = false;
    connection.turnSpokenText = '';
    connection.ttsTotalMs = 0;
    connection.turnAlignmentChars = [];
    connection.turnAlignmentStarts = [];
    connection.turnAudioMs = 0;
    connection.latencyTrace = new TurnLatencyTrace();
    connection.latencyTrace.markSttFinal();
    connection.latencyTrace.transcript = trimmed.slice(0, 80);
    connection.lastTurnTrace = connection.latencyTrace;

    // F5b — arm the filler timer (flag voice.filler, default off): if the
    // first LLM text chunk has not arrived within FILLER_GRACE_MS, the gap
    // is real and the pre-generated "Mmm." covers it. Disarmed by the first
    // text_chunk (the channel listener) — a fast chunk means no filler, the
    // filler only covers the REAL gap. See playFiller for the delivery.
    this.armFiller(connectionId);

    // Barge-in context (REQ-4): the interrupting utterance enters the
    // pipeline WITH the playback-position note — the model knows what the
    // user actually heard and answers the new question without repeating
    // the unheard part. Consumed once.
    const bargeInContext = connection.pendingBargeInContext;
    connection.pendingBargeInContext = null;

    // Layer-3 context note (REQ-7, F2a): rides the FIRST agent turn after
    // connect or a mode change — the LLM knows it is in a voice session
    // (spoken response, minimal answer for filler/noise). Consumed once.
    const voiceContext = connection.pendingVoiceContext;
    connection.pendingVoiceContext = null;

    // Overheard session memory (REQ-9, F2b): everything heard but not
    // addressed since the last activated turn rides THIS turn as context —
    // the agent can answer "¿qué hemos hablado?" and follow the thread of
    // the meeting. Consumed once: from here on the LLM's own history carries
    // it (the lines are in the channel history and session_messages as well).
    const overheardContext = this.buildOverheardContext(connection.overheardBuffer);
    connection.overheardBuffer = [];
    // @todo nira - 2026-10-13 : with persistOverheardToSessionStore now writing
    // every overheard line into session_messages as it is heard, this riding
    // note duplicates what the LLM history already carries. Once the
    // persistence path is proven in production, drop the note (and the buffer)
    // and let history be the only delivery vehicle — pending writes would then
    // need an await before the turn dispatch to keep the race window closed.

    const contextParts = [voiceContext, bargeInContext, overheardContext].filter(Boolean);
    const turnText = contextParts.length > 0 ? `${trimmed}\n\n${contextParts.join('\n\n')}` : trimmed;

    // THE TURN — the Teros agent IS the brain. Same path as a text message:
    // tools, permissions, streaming, persistence all come from this call.
    // onComplete fires when the turn finishes → drain the remaining TTS.
    // F5a: voiceTurn=true lets the message handler resolve the `voice.llm`
    // flag per user — 'fast' swaps THIS turn's model for a fast model with a
    // trimmed context (the leg is reported back to stamp the latency trace).
    const messageId = this.channelManager.createMessageId();
    connection.latencyTrace.markDispatched();
    this.messageHandler
      .processAgentResponse(
        connection.channelId,
        connection.agentId,
        turnText,
        messageId,
        () => {
          const conn = this.connections.get(connectionId);
          if (conn && conn.ttsActive) conn.tts.endOfText();
        },
        undefined,
        undefined,
        true,
        (leg, info) => {
          const conn = this.connections.get(connectionId);
          if (conn?.latencyTrace) {
            conn.latencyTrace.llmLeg = leg;
            conn.latencyTrace.markLlmDispatch();
            conn.latencyTrace.toolCount = info?.toolCount ?? null;
          }
        },
      )
      .catch((err) => {
        console.error('[VoiceLoop] Agent turn error:', err);
        const conn = this.connections.get(connectionId);
        if (!conn) return;
        if (conn.ttsActive) { conn.tts.cancel(); conn.ttsActive = false; }
        // F5h: the failed epoch is dead — its safety timer must not fire
        // into a later stream (all stream-open paths clear it too; this
        // covers the no-stream edge).
        if (conn.playbackSafetyTimer) {
          clearTimeout(conn.playbackSafetyTimer);
          conn.playbackSafetyTimer = null;
        }
        // Failed turn: record whatever segments completed (F1b, NFR-1) and
        // clear the trace so the next turn starts fresh.
        if (conn.latencyTrace) {
          this.latencyBudget.record(conn.latencyTrace, { bargeIn: false });
          conn.latencyTrace = null;
        }
        this.sendToClient(conn.clientWs, {
          type: 'error', code: 'server_error', message: 'The agent turn failed.',
        });
      });
  }

  /**
   * Persist one overheard utterance to the session store (session_messages)
   * as a synthetic user message so the LLM context of every subsequent turn —
   * voice OR text — carries it (REQ-9, F2b; the voice→text continuity fix).
   *
   * Mirrors the legacy VoiceHandler AF-5 dual-write
   * (persistTranscriptToSessionStore) but marks the part
   * `synthetic` + metadata { source: 'voice', overheard: true } so compaction
   * and any future filtering can tell spoken-ambient lines apart from typed
   * turns. Fire-and-forget: a session-store failure must never break the
   * voice loop (the channel_messages row is already the source of truth for
   * the UI; this write is the LLM-context mirror).
   */
  private async persistOverheardToSessionStore(
    connection: VoiceLoopConnection,
    text: string,
  ): Promise<void> {
    if (!this.sessionStore) return;
    try {
      const now = Date.now();
      const random = Math.random().toString(36).substring(2, 9);
      const msgId = `msg_${now}_${random}`;
      const partId = `part_${now}_${random}`;

      // Minimal UserMessage shape — the session store only reads info.role
      // and parts when assembling LLM context (same pattern as the legacy
      // handler's AF-5 write and MessageHandler.persistToSessionStore).
      const sessionMsg = {
        id: msgId,
        sessionID: connection.channelId,
        role: 'user' as const,
        time: { created: now },
      };
      await this.sessionStore.writeMessage(sessionMsg as any);

      const textPart = {
        id: partId,
        sessionID: connection.channelId,
        messageID: msgId,
        type: 'text' as const,
        text,
        time: { start: now, end: now },
        synthetic: true,
        metadata: { source: 'voice', overheard: true },
      };
      await this.sessionStore.writePart(textPart as any);
    } catch (err) {
      console.error('[VoiceLoop] Failed to persist overheard to session store:', err);
    }
  }

  /**
   * Build the overheard context note (REQ-9, F2b) from the session-memory
   * buffer: a bracketed note listing what was heard but not addressed since
   * the last activated turn. Same mechanism as the barge-in/voice-session
   * notes — it rides the turn text (session_messages/LLM view), never the
   * visible channel transcript. Empty buffer → no note (no noise).
   *
   * The lines are ALSO in the LLM history individually
   * (persistOverheardToSessionStore); the note gives the activated turn one
   * inline, ordered view of the ambient thread without depending on the
   * per-utterance writes having landed.
   */
  private buildOverheardContext(overheard: string[]): string | null {
    if (overheard.length === 0) return null;
    const lines = overheard
      .map((text) => `- ${text.length > 200 ? `${text.slice(0, 197)}…` : text}`)
      .join('\n');
    return `[Desde el último turno has oído (sin dirigirse a ti) lo siguiente; es contexto de la sesión, visible para ti como memoria:\n${lines}]`;
  }

  // ---------------------------------------------------------------------------
  // FILLER PHRASE (F5b — flag voice.filler, default off)
  // ---------------------------------------------------------------------------

  /**
   * Arm the filler timer for an activated turn (F5b). No-op unless the
   * connection resolved voice.filler=true. The timer fires after
   * FILLER_GRACE_MS of no first LLM text chunk — the gap is real, play the
   * pre-generated "Mmm." (playFiller). The channel listener's first
   * text_chunk handler disarms it (disarmFiller) — a chunk inside the
   * window means the LLM is fast and the filler would only compete with
   * the real answer.
   */
  private armFiller(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.fillerEnabled) return;
    // Never two fillers: a stale timer from a previous turn is cleared
    // first (the previous turn's chunk never arrived — its filler fired
    // or its turn died; either way it is dead).
    if (connection.fillerTimer) clearTimeout(connection.fillerTimer);
    connection.fillerTimer = setTimeout(() => {
      connection.fillerTimer = null;
      this.playFiller(connectionId);
    }, FILLER_GRACE_MS);
  }

  /**
   * Disarm the pending filler timer (F5b) — the first LLM text chunk
   * arrived inside the grace window. Called by the channel listener on
   * the FIRST text_chunk of the turn only (the trace's firstTextChunkAt
   * being still null is the "first" test — the listener marks it right
   * after this call).
   */
  private disarmFiller(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.fillerTimer) return;
    clearTimeout(connection.fillerTimer);
    connection.fillerTimer = null;
  }

  /**
   * Play the pre-generated filler (F5b): the grace window elapsed with no
   * first LLM chunk — the gap is real. Delivers the baked "Mmm." MP3 as
   * ordinary tts_chunk frames bracketed by speaking_started/speaking_ended,
   * so the client's useTtsPlayer plays it through the same FIFO/stop
   * machinery — a barge-in interrupt stops it exactly like any TTS (the
   * client-side stop() empties the queue; the server-side handleBargeIn
   * sends the interrupt frame).
   *
   * NOT the ElevenLabs stream: no speak()/feed() — the filler never opens
   * a synthesis stream, so it can never collide with the real turn's TTS
   * (which opens when its own first chunk arrives). If the real chunk
   * arrives WHILE the filler sounds, the listener sees ttsActive=false and
   * fillerPlaying=true → it defers opening the TTS stream to the filler's
   * end (never two audios at once); the text itself is never lost (it
   * accumulates in turnSpokenText and feeds when the stream opens).
   *
   * Stamps the trace (fillerPlayed=true) so the latency budget can split
   * the e2e histogram with-vs-without filler (F5b telemetry).
   */
  private playFiller(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    // The turn may have died (barge-in froze it / connection closing) —
    // a filler over a dead turn is noise.
    if (connection.turnFrozen) return;
    const frames = fillerChunkFrames();
    if (frames.length === 0) return; // asset missing — silent degradation

    connection.fillerPlaying = true;
    if (connection.latencyTrace) connection.latencyTrace.fillerPlayed = true;
    // PoC instrumentation (2026-10-31): the filler is NOT the answer. It used
    // to mark firstAudio, which made the e2e histogram report ~0.5 s while the
    // real answer took 3-6 s. The trace now measures the answer only;
    // `fillerPlayed` records that the gap was covered.

    this.sendToClient(connection.clientWs, { type: 'speaking_started' });
    for (const frame of frames) {
      this.sendToClient(connection.clientWs, { type: 'tts_chunk', audio_base_64: frame });
    }
    this.sendToClient(connection.clientWs, { type: 'speaking_ended' });
    // The filler is a complete sentence MP3 delivered in one burst — the
    // client decodes it as one unit. fillerPlaying clears when the real
    // turn's TTS opens (the listener checks it there); a barge-in during
    // the filler kills it client-side (interrupt → stop) and the turn
    // freeze keeps any late filler-adjacent state consistent.
    connection.fillerPlaying = false;
    console.log(
      `[VoiceLoop] Filler played (voice.filler) on channel ${connection.channelId} — first LLM chunk >${FILLER_GRACE_MS}ms`,
    );
  }

  /**
   * Persist one transcript line to channel_messages (source:'voice') and
   * broadcast it to the channel. The agent turn's own persistence
   * (session_messages via prompt + assistant messages via streaming-state)
   * is handled by the text pipeline — this loop never duplicates it.
   */
  private async persistTranscript(
    connection: VoiceLoopConnection,
    text: string,
    isUser: boolean,
    overheard: boolean,
  ): Promise<void> {
    const messageId = this.channelManager.createMessageId();
    const message = {
      messageId,
      channelId: connection.channelId,
      role: isUser ? 'user' : 'assistant',
      content: { type: 'text', text },
      source: 'voice',
      ...(overheard ? { overheard: true } : {}),
      timestamp: new Date().toISOString(),
    };
    await this.channelManager.saveMessage(message as any);
    this.pubSubService?.broadcastToTopic(`channel:${connection.channelId}`, {
      type: 'message',
      channelId: connection.channelId,
      message,
    });
  }

  /**
   * The client's REAL playback position at a cut (its audio clock, sent right
   * after it stopped). The VAD barge-in only knew how much audio was
   * delivered; this refines the heard text, the event row and the message
   * mark with what actually sounded (PoC 2026-10-31).
   */
  private handlePlaybackPosition(connectionId: string, positionMs: number): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.turnFrozen || !Number.isFinite(positionMs)) return;
    const clamped = Math.max(0, Math.min(positionMs, Math.max(connection.ttsTotalMs, connection.turnAudioMs)));
    connection.lastPlaybackPositionMs = clamped;
    const heard = this.heardPrefix(connection, clamped);
    const heardText = heard.text.trim();
    const seconds = Math.round(clamped / 100) / 10;
    connection.pendingBargeInContext = heardText
      ? `[El usuario interrumpió la respuesta hablada tras ~${seconds}s de audio; oyó hasta: "${heardText}". No repitas lo no oído: responde a lo nuevo.]`
      : `[El usuario interrumpió la respuesta hablada de inmediato. No repitas lo no oído: responde a lo nuevo.]`;
    this.markCutOnMessage(connection, clamped);
    console.log(`[VoiceLoop] Barge-in refined by client position: ${clamped}ms → ${heard.chars} chars heard (exact=${heard.exact})`);
  }

  // ---------------------------------------------------------------------------
  // CHANNEL LISTENER — taps the agent turn's broadcasts for TTS + UI frames
  // ---------------------------------------------------------------------------

  private makeChannelListener(connectionId: string): ChannelMessageListener {
    return (raw: string) => {
      const connection = this.connections.get(connectionId);
      if (!connection) return;
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      // Assistant text deltas → TTS streaming + agent_response_delta frames.
      if (msg.type === 'message_chunk' && msg.chunkType === 'text_chunk' && typeof msg.text === 'string') {
        // Barge-in freeze (REQ-4, F1b): late chunks of the interrupted turn
        // must never (re)open the TTS — never two audios at once. Chunks of
        // the frozen turn's messageId are dead forever (even after the freeze
        // is lifted for the interrupting turn — the old turn is gone).
        if (connection.frozenMessageId !== null && msg.messageId === connection.frozenMessageId) {
          return;
        }
        if (connection.turnFrozen) {
          // Frozen and not the frozen turn's own chunk (e.g. an unrelated
          // write): stay silent until the interrupting utterance's turn lifts
          // the freeze in handleFinalTranscript.
          return;
        }
        // F5b: the FIRST text chunk of the turn disarms the pending filler
        // timer — the LLM answered inside the grace window, the filler
        // would only compete with the real answer. (The trace's
        // firstTextChunkAt being still null is the "first" test — it is
        // marked right below.)
        if (connection.latencyTrace && connection.latencyTrace.firstTextChunkAt === null) {
          this.disarmFiller(connectionId);
        }
        if (!connection.tts.isSpeaking()) {
          // F5b: the filler may still be sounding (its frames were sent in
          // one burst; the client is playing them). Never two audios at
          // once: the real TTS stream opens only after the filler drained.
          // The filler burst is sent synchronously in playFiller, so by the
          // time a text chunk arrives the burst is already out —
          // fillerPlaying is false again and the stream opens normally.
          // (Kept as an explicit guard for clarity + future streaming
          // fillers.)
          if (connection.fillerPlaying) return;
          // F5h: the stream opens on the PROVIDER's state (isSpeaking), not
          // on ttsActive — ttsActive now stays armed through the client's
          // playback window (barge-in coverage). A new agent turn arriving
          // in that window (typed message, ack) must still open a fresh
          // stream exactly as before. The old epoch's safety timer is
          // superseded here: its audio queues before this stream's on the
          // client, and the client swallows stale drain edges (a newer
          // speaking_started re-arms its drain gate) — this epoch arms a
          // fresh timer at its own onEnd.
          if (connection.playbackSafetyTimer) {
            clearTimeout(connection.playbackSafetyTimer);
            connection.playbackSafetyTimer = null;
          }
          connection.ttsActive = true;
          connection.turnSpokenMessageId = typeof msg.messageId === 'string' ? msg.messageId : null;
          connection.latencyTrace?.markFirstTextChunk();
          // F5d: stamp the TTS strategy on the trace so the budget can split
          // the TTS histogram by mode (stream vs sentences).
          if (connection.latencyTrace) connection.latencyTrace.ttsMode = connection.ttsMode;
          connection.tts.speak(this.makeTtsCallbacks(connectionId));
        }
        connection.turnSpokenText += msg.text;
        connection.tts.feed(msg.text);
        this.sendToClient(connection.clientWs, { type: 'agent_response_delta', text: msg.text });
        return;
      }

      // Tool lifecycle → tool_call / tool_result frames (activity waiting_worker
      // is derived client-side from these).
      if (msg.type === 'message_chunk' && msg.chunkType === 'tool_call_start') {
        // Diagnostic (PoC 2026-10-31, Pablo: "el audio se pausa durante la tool
        // call"): how much of the text fed to the TTS has actually been
        // synthesized when the model stops to call a tool. ElevenLabs
        // stream-input buffers up to the current chunk_length_schedule
        // threshold (50→250 chars) and nothing flushes it here.
        if (connection.ttsActive) {
          console.log(
            `[VoiceTrace] {"event":"tool_call_start","channel":"${connection.channelId}","tool":${JSON.stringify(msg.toolName ?? '')},"fedChars":${connection.turnSpokenText.length},"synthesizedChars":${connection.turnAlignmentChars.length},"audioMs":${Math.round(connection.turnAudioMs)}}`,
          );
          // Pablo (PoC 2026-10-31, approved): say the preface NOW — the text
          // fed so far is synthesized while the tool runs; the turn stays
          // open for the text that follows the tool result.
          if (connection.tts.isSpeaking()) connection.tts.flush?.();
        }
        this.sendToClient(connection.clientWs, {
          type: 'tool_call', toolName: msg.toolName, message: msg.toolName,
        });
        return;
      }
      if (msg.type === 'message_chunk' && msg.chunkType === 'tool_call_complete') {
        const output = typeof msg.toolOutput === 'string' ? msg.toolOutput : undefined;
        this.sendToClient(connection.clientWs, {
          type: 'tool_result', text: output ?? (msg.toolError ? `Error: ${msg.toolError}` : undefined),
        });
        return;
      }

      // Permission requests (F0 pattern): verbal + card notification. The
      // permission modal itself lives in the conversation channel UI.
      if (msg.type === 'tool_permission_request') {
        const executorChannelId: string = msg.channelId ?? connection.channelId;
        void (async () => {
          let observedChannelName = executorChannelId;
          try {
            const ch = await this.channelManager.getChannel(executorChannelId);
            observedChannelName = (ch as any)?.metadata?.name || executorChannelId;
          } catch { /* keep fallback */ }
          const conn = this.connections.get(connectionId);
          if (!conn) return;
          this.sendToClient(conn.clientWs, {
            type: 'channel_event',
            eventType: 'channel_permission',
            observedChannelId: executorChannelId,
            observedChannelName,
            toolName: msg.toolName,
          });
        })();
        return;
      }

      // Turn complete → drain the remaining TTS (final partial sentence).
      if (msg.type === 'queue_state' && msg.state === 'done') {
        if (connection.ttsActive) connection.tts.endOfText();
        return;
      }
    };
  }

  /** TTS stream callbacks → tts_chunk frames + speaking marks + latency. */
  private makeTtsCallbacks(connectionId: string) {
    return {
      onStart: () => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        connection.firstTtsAudioAt = Date.now();
        connection.latencyTrace?.markFirstAudio();
        if (connection.sttFinalAt) {
          connection.lastLatencyMs = connection.firstTtsAudioAt - connection.sttFinalAt;
          // Session telemetry (F4, NFR-1): one end-to-end sample this session.
          connection.sessionTelemetry.recordEndToEndLatency(connection.lastLatencyMs);
          console.log(
            `[VoiceLoop] Latency STT-final → first TTS audio: ${connection.lastLatencyMs}ms (channel ${connection.channelId})`,
          );
        }
        this.emitTrace(connection, 'first_audio');
        this.sendToClient(connection.clientWs, {
          type: 'speaking_started', messageId: connection.turnSpokenMessageId,
        });
      },
      onSegment: (alignment: TtsAlignment | null) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        if (alignment) {
          // ElevenLabs stream-input reports char times CUMULATIVE over the
          // whole stream (measured 2026-10-31: segment k starts where k-1
          // ended), not per chunk as the docs suggest. Use them as-is; only
          // if a provider ever sends per-chunk times (first start well below
          // the audio already produced) add the offset.
          const offset = connection.turnAudioMs;
          const first = alignment.charStartTimesMs[0];
          const base = offset > 500 && first < offset * 0.5 ? offset : 0;
          for (let i = 0; i < alignment.chars.length; i++) {
            connection.turnAlignmentChars.push(alignment.chars[i]);
            connection.turnAlignmentStarts.push(base + alignment.charStartTimesMs[i]);
          }
          const last = alignment.chars.length - 1;
          connection.turnAudioMs = base + alignment.charStartTimesMs[last] + alignment.charDurationsMs[last];
          // The alignment knows the real duration — replace the chunk-count
          // estimate for the barge-in window and the position clamp.
          connection.ttsTotalMs = connection.turnAudioMs;
        }
        this.sendToClient(connection.clientWs, { type: 'tts_segment', alignment });
      },
      onChunk: (base64Audio: string) => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        // Playback position bookkeeping (REQ-4, F1b): every delivered chunk
        // extends the audio the user has actually heard.
        connection.ttsTotalMs += TTS_CHUNK_MS;
        this.sendToClient(connection.clientWs, { type: 'tts_chunk', audio_base_64: base64Audio });
      },
      onEnd: () => {
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        // F5h: send-end is NOT playback-end. With streaming TTS the client
        // holds seconds of buffered audio past this instant — ttsActive stays
        // armed (the barge-in window must cover the audio the user still
        // hears) and a safety timeout guards against a client that never
        // sends playback_ended (old client, WebAudio unavailable, frozen tab).
        this.armPlaybackSafetyTimer(connectionId);
        // Dialogue state (F2a, REQ-7 layer 2): the agent's turn just drained —
        // a reply in the next utterance is more likely directed at her.
        connection.gateDialogue.agentJustSpoke = true;
        // Dialogue window: armed ONLY from the client's real end of playback
        // (handlePlaybackEnded) — a provisional arm from here (send-end +
        // audio length) kept the door open far too long (PoC round 5).
        // The turn's audio fully drained — record it in the latency budget
        // (F1b, NFR-1) and clear the per-turn trace.
        if (connection.latencyTrace) {
          this.latencyBudget.record(connection.latencyTrace, { bargeIn: false });
          connection.latencyTrace = null;
        }
        // speaking_ended stays at send-end (F5h): the client's drain edge
        // (onSpeakingEnded → flushPending) depends on it arriving NOW to
        // flush the last sentence into its playback queue — moving it to
        // playback-time would drop the turn's last sentence. The orb turns
        // off on the client's own drain edge (onPlaybackEnded), so the UI
        // still reflects the audio the user is actually hearing.
        this.sendToClient(connection.clientWs, { type: 'speaking_ended' });
      },
      onError: (err: Error) => {
        console.error('[VoiceLoop] TTS error:', err.message);
        const connection = this.connections.get(connectionId);
        if (!connection) return;
        connection.ttsActive = false;
        // F5h: the errored epoch will never drain (its speaking_ended never
        // went out — the client's drain gate never armed) — drop the timer.
        if (connection.playbackSafetyTimer) {
          clearTimeout(connection.playbackSafetyTimer);
          connection.playbackSafetyTimer = null;
        }
        // Audio drop, not session death (F4 robustez): the turn's text is
        // still in the thread; the session lives on (the next turn retries).
        connection.sessionTelemetry.recordTtsError();
        if (connection.latencyTrace) {
          this.latencyBudget.record(connection.latencyTrace, { bargeIn: false });
          connection.latencyTrace = null;
        }
        this.sendToClient(connection.clientWs, {
          type: 'error', code: 'tts_error', message: err.message,
        });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // AUTH
  // ---------------------------------------------------------------------------

  private async authenticateUser(sessionId: string): Promise<string | null> {
    try {
      if (sessionId.startsWith('tak:')) {
        const tokenDoc = await resolveApiToken(this.db, sessionId.slice(4));
        return tokenDoc ? tokenDoc.userId : null;
      }
      const result = await this.authService.validateSession(sessionId);
      return result.success ? result.user!.userId : null;
    } catch (error) {
      console.error('[VoiceLoop] Auth error:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // VOICE SESSIONS (voice_sessions collection — same shape as F0)
  // ---------------------------------------------------------------------------

  private async upsertVoiceSession(connection: VoiceLoopConnection): Promise<void> {
    try {
      const now = new Date();
      await this.db.collection('voice_sessions').updateOne(
        { channelId: connection.channelId, agentId: connection.agentId },
        {
          $set: {
            userId: connection.userId,
            mode: connection.mode,
            engine: 'native',
            presence: 'on',
            lastActivityAt: now,
            updatedAt: now,
          },
          $setOnInsert: {
            sessionId: `vs_${now.getTime()}_${Math.random().toString(36).substring(2, 9)}`,
            channelId: connection.channelId,
            agentId: connection.agentId,
            ...(connection.workspaceId ? { workspaceId: connection.workspaceId } : {}),
            startedAt: now,
            createdAt: now,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error('[VoiceLoop] Failed to upsert voice session:', err);
    }
  }

  private async touchVoiceSession(connection: VoiceLoopConnection): Promise<void> {
    try {
      await this.db.collection('voice_sessions').updateOne(
        { channelId: connection.channelId, agentId: connection.agentId },
        { $set: { mode: connection.mode, lastActivityAt: new Date() } },
      );
    } catch (err) {
      console.error('[VoiceLoop] Failed to touch voice session:', err);
    }
  }

  private async closeVoiceSession(connection: VoiceLoopConnection): Promise<void> {
    try {
      await this.db.collection('voice_sessions').updateOne(
        { channelId: connection.channelId, agentId: connection.agentId },
        { $set: { presence: 'off', mode: connection.mode, endedAt: new Date() } },
      );
    } catch (err) {
      console.error('[VoiceLoop] Failed to close voice session:', err);
    }
  }

  /**
   * Prior voice-session record for this channel+agent (REQ-6: mode survives
   * reconnections) — used both to restore the mode and, in F4, to classify a
   * new connection as a RECONNECT (session was live or active within
   * RECONNECT_WINDOW_MS) vs a fresh activation.
   */
  private async loadVoiceSessionRecord(
    channelId: string,
    agentId: string,
  ): Promise<any | null> {
    try {
      return await this.db.collection('voice_sessions').findOne({ channelId, agentId });
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // HISTORY (same query + system-line filter as the legacy handler)
  // ---------------------------------------------------------------------------

  private async loadHistoricTranscripts(
    channelId: string,
    limit = 50,
  ): Promise<VoiceLoopHistoricTranscript[]> {
    try {
      const messages = await this.db.collection('channel_messages')
        .find(
          { channelId, role: { $in: ['user', 'assistant'] }, 'content.type': 'text' },
          { sort: { timestamp: -1 }, limit } as any,
        )
        .toArray();

      if (!messages.length) return [];

      return (messages as any[])
        .reverse()
        .filter((m: any) => {
          const text: string = m.content?.text || '';
          if (text.startsWith('🛠️ send-message →')) return false;
          if (text.startsWith('🛠️ execute-tool →')) return false;
          if (text.startsWith('✅ Respuesta de agente')) return false;
          if (text.startsWith('❌ Error en')) return false;
          return true;
        })
        .map((m: any) => ({
          id: m.messageId || m._id?.toString() || `${Date.now()}_${Math.random()}`,
          text: m.content?.text || '',
          isUser: m.role === 'user',
          timestamp: new Date(m.timestamp).getTime(),
          type: 'transcript' as const,
        }));
    } catch (err) {
      console.error('[VoiceLoop] Error loading historic transcripts:', err);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------------

  private cleanup(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    console.log(`[VoiceLoop] Cleanup: ${connectionId}`);

    // Session telemetry (F4, REQ-11): seal the health record and persist it —
    // the session's turns/overheard/barge-ins/drops/duration outlive the
    // connection. Fire-and-forget: cleanup must never block on the sink.
    connection.sessionTelemetry.close();
    this.persistSessionTelemetry(connection.sessionTelemetry.snapshot()).catch((err) => {
      console.error('[VoiceLoop] Failed to persist session telemetry:', err);
    });
    // No connections left → the periodic flush has nothing to flush.
    if (this.connections.size === 1) this.stopTelemetryFlushTimer();

    this.pubSubService?.removeListener(connection.channelId, connection.listener);
    connection.stt.close();
    connection.tts.cancel();
    // A closing session has no pause to return from (REQ-8) — drop the timer.
    if (connection.pauseTimer) {
      clearTimeout(connection.pauseTimer);
      connection.pauseTimer = null;
    }
    // F5b: a closing session has no filler to play either — drop the timer.
    if (connection.fillerTimer) {
      clearTimeout(connection.fillerTimer);
      connection.fillerTimer = null;
    }
    connection.fillerPlaying = false;
    // F5h: a closing session has no playback window to guard — drop the timer.
    if (connection.playbackSafetyTimer) {
      clearTimeout(connection.playbackSafetyTimer);
      connection.playbackSafetyTimer = null;
    }
    this.closeVoiceSession(connection).catch(() => {});
    connection.clientWs?.close();
    this.connections.delete(connectionId);
  }

  cleanupAll(): void {
    console.log('[VoiceLoop] Cleaning up all connections');
    for (const connectionId of Array.from(this.connections.keys())) {
      this.cleanup(connectionId);
    }
    this.stopTelemetryFlushTimer();
  }

  // ---------------------------------------------------------------------------
  // OBSERVABILITY (tests + metrics)
  // ---------------------------------------------------------------------------

  getActiveConnectionsCount(): number {
    return this.connections.size;
  }

  /** Last measured STT-final → first-TTS-audio latency for a connection (ms). */
  getLastLatencyMs(connectionId: string): number | null {
    return this.connections.get(connectionId)?.lastLatencyMs ?? null;
  }

  /**
   * Last playback position (ms) registered by a barge-in on a connection —
   * what the user actually heard of the interrupted response (REQ-4, F1b).
   */
  getLastPlaybackPositionMs(connectionId: string): number | null {
    return this.connections.get(connectionId)?.lastPlaybackPositionMs ?? null;
  }

  /**
   * Latency budget (F1b, NFR-1): p50/p95 per segment + end-to-end, with the
   * within-budget verdict against the NFR lines. REQ-11: the metrics of the
   * loop, live for the dashboard (F4 wires persistence/rollups).
   */
  getLatencyStats(): LatencyStats[] {
    return this.latencyBudget.statsAll();
  }

  /** Barge-in rate (REQ-11): barge-ins / turns on this backend instance. */
  getBargeInRate(): number {
    return this.latencyBudget.bargeInRate();
  }

  /**
   * Gate decision telemetry (F2a, REQ-11/UC-12): per-mode counters,
   * activations by layer, mean classifier score (layer 2 removed with
   * `attention`, Pablo 2026-10-05), and the
   * false-positive/negative proxies. F4 wires persistence/dashboards.
   */
  getGateTelemetry(): GateTelemetryStats {
    return this.gateTelemetry.stats();
  }

  /** Recent gate decision log entries (newest last) — inspection/debugging. */
  getGateDecisionLog(limit = 50) {
    return this.gateTelemetry.entries(limit);
  }

  // ---------------------------------------------------------------------------
  // SESSION TELEMETRY (F4, REQ-11/UC-12) — persistence + query surface
  // ---------------------------------------------------------------------------

  /**
   * Persist one session health record (upsert — the periodic flush and the
   * close flush write the SAME record, keyed by session start). The document
   * carries the snapshot + a `recordId` join key (channelId+startedAt) so the
   * gate-decision log entries (which carry channelId+ts) can be joined per
   * session downstream: the UC-12 per-session false-positive/negative rate
   * is exactly that join.
   */
  private async persistSessionTelemetry(snapshot: VoiceSessionTelemetrySnapshot): Promise<void> {
    try {
      await this.db.collection('voice_telemetry_sessions').updateOne(
        { recordId: `${snapshot.channelId}:${snapshot.startedAt}` },
        {
          $set: {
            ...snapshot,
            recordId: `${snapshot.channelId}:${snapshot.startedAt}`,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (err) {
      console.error('[VoiceLoop] Failed to persist session telemetry:', err);
    }
  }

  /**
   * Ensure the periodic telemetry flush is running (F4): every 60 s each OPEN
   * session persists a live snapshot — a backend crash must not lose the
   * record of an in-flight session (AC-6 always-on means sessions run for
   * hours). One interval for all connections; stopped when the last one goes.
   */
  private ensureTelemetryFlushTimer(): void {
    if (this.telemetryFlushTimer) return;
    this.telemetryFlushTimer = setInterval(() => {
      for (const connection of this.connections.values()) {
        this.persistSessionTelemetry(connection.sessionTelemetry.snapshot()).catch(() => {});
      }
    }, 60_000);
    // The interval must never hold the process open on shutdown.
    (this.telemetryFlushTimer as any).unref?.();
  }

  private stopTelemetryFlushTimer(): void {
    if (this.telemetryFlushTimer) {
      clearInterval(this.telemetryFlushTimer);
      this.telemetryFlushTimer = null;
    }
  }

  /**
   * Live session health records (F4 query surface): one snapshot per OPEN
   * connection — the `admin-api.voice-telemetry-sessions` action reads this
   * plus the persisted `voice_telemetry_sessions` for closed ones.
   */
  getLiveSessionTelemetry(): VoiceSessionTelemetrySnapshot[] {
    return Array.from(this.connections.values()).map((c) => c.sessionTelemetry.snapshot());
  }

  /**
   * The fleet health summary (F4, AC-9): latency budget (p50/p95 per segment
   * + end-to-end with NFR verdicts), barge-in rate, gate counters with the
   * false-positive/negative proxies, and the hour-bucketed gate rollup (the
   * "falsas activaciones/hora" derivation). One call = the whole dashboard.
   */
  getVoiceHealthSummary() {
    return {
      latency: this.latencyBudget.statsAll(),
      // F5a: the LLM segment split by leg — fast vs agent over the same
      // sttFinal→firstTextChunk segment. The evidence for whether the fast
      // leg actually cut the 70% LLM share of the turn latency.
      llmByLeg: this.latencyBudget.statsByLlmLeg(),
      // F5d: the TTS segment split by mode — stream (stream-input WS) vs
      // sentences (HTTP per sentence) over the same firstTextChunk→firstAudio
      // segment. The evidence for whether the WS actually cut the TTS share.
      ttsByMode: this.latencyBudget.statsByTtsMode(),
      // F5b: the end-to-end segment split by filler — turns where the
      // pre-generated "Mmm." played vs turns where it did not, over the same
      // speechEnd→firstAudio segment. The evidence for whether the filler
      // actually improved the PERCEIVED latency (the ms do not change; what
      // changes is that the user hears something instead of dead silence).
      endToEndByFiller: this.latencyBudget.statsByFiller(),
      bargeInRate: this.latencyBudget.bargeInRate(),
      gate: this.gateTelemetry.stats(),
      gateHourly: rollupGateDecisions(this.gateTelemetry.entries(500)),
      activeConnections: this.connections.size,
    };
  }

  // ---------------------------------------------------------------------------
  // AGENT MODE TOOLS (REQ-8, F2b — set_mode / get_mode / pause_listening)
  // ---------------------------------------------------------------------------

  /**
   * Is there an active voice session (native loop) for this channel+agent?
   * The seam the tool executor consults to decide whether the mode tools are
   * available this turn (REQ-8: the tools exist only inside a voice session —
   * "cállate media hora" in a text chat has no mode to change).
   */
  isVoiceSessionActive(channelId: string, agentId: string): boolean {
    for (const connection of this.connections.values()) {
      if (connection.channelId === channelId && connection.agentId === agentId) {
        return true;
      }
    }
    return false;
  }

  /**
   * The current mode of the active voice session for a channel+agent, or null
   * when none is active (REQ-8: `get_mode` tool result).
   */
  getVoiceSessionMode(channelId: string, agentId: string): VoiceMode | null {
    for (const connection of this.connections.values()) {
      if (connection.channelId === channelId && connection.agentId === agentId) {
        return connection.mode;
      }
    }
    return null;
  }

  /**
   * Set the mode of the active voice session for a channel+agent (REQ-8:
   * `set_mode` tool — the agent's OWN door, same authoritative state as the
   * voice and UI doors). Returns the applied mode or null when no session is
   * active (the tool reports that to the LLM).
   */
  setVoiceSessionMode(channelId: string, agentId: string, mode: VoiceMode): VoiceMode | null {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.channelId === channelId && connection.agentId === agentId) {
        // The agent's ack is its own spoken turn — the tool does not inject a
        // canned ack on top of the agent's response (REQ-8: "por decisión
        // propia, con ceremonia visual y ack" — the ack IS the agent's turn).
        this.applyModeCommand(connectionId, { mode, ack: '', pattern: 'agent-tool' }, 'system');
        return connection.mode;
      }
    }
    return null;
  }

  /**
   * Pause listening for N minutes (REQ-8, AC-7: "cállate media hora que tengo
   * una reunión"). Passive + a timed auto-return: the loop keeps transcribing
   * to context (REQ-9) but only the vocative opens a turn, and the mode
   * restores itself when the pause elapses (the timer is cleared on any
   * later mode change — a door that opened overrides the pause). Returns the
   * applied minutes or null when no session is active.
   */
  pauseVoiceSessionListening(channelId: string, agentId: string, minutes: number): number | null {
    const clamped = Math.min(480, Math.max(1, Math.round(minutes)));
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.channelId === channelId && connection.agentId === agentId) {
        this.applyModeCommand(connectionId, { mode: 'passive', ack: '', pattern: 'agent-tool' }, 'system');
        // Clear any prior pause — the newest pause wins.
        if (connection.pauseTimer) {
          clearTimeout(connection.pauseTimer);
        }
        connection.pauseTimer = setTimeout(() => {
          this.onPauseElapsed(connectionId);
        }, clamped * 60_000);
        return clamped;
      }
    }
    return null;
  }

  /**
   * The pause elapsed (REQ-8): the session returns to `conversation` (the
   * default mode, decisión #4) — unless the user changed the mode meanwhile
   * (a door that opened overrode the pause; the timer is cleared then, but
   * this also guards a race where the clear happened after the callback was
   * already queued). Private; tests drive it directly (deterministic — no
   * timer mocking in the harness).
   */
  private onPauseElapsed(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.pauseTimer = null;
    // Auto-return to conversation (the default mode, decisión #4) — only if
    // the user has not changed the mode meanwhile.
    if (conn.mode === 'passive') {
      this.applyModeCommand(connectionId, { mode: 'conversation', ack: '', pattern: 'pause-elapsed' }, 'system');
      console.log(`[VoiceLoop] pause_listening elapsed — mode restored to 'conversation' for channel ${conn.channelId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // UTILS
  // ---------------------------------------------------------------------------

  private sendToClient(ws: WebSocket, frame: VoiceLoopServerFrame): void {
    if ((ws as any).readyState === 1) {
      (ws as any).send(JSON.stringify(frame));
    }
  }
}
