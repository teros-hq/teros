/**
 * VoiceSessionContext
 *
 * Global context that keeps the voice session active independently
 * of the VoiceWindow lifecycle. The WebSocket and AudioContext live
 * here — they are never destroyed when switching tabs.
 *
 * Pattern:
 * - VoiceSessionProvider  → root of the workspace, always mounted
 * - useVoiceSession()     → consumed by VoiceWindowContent (UI only)
 * - startSession(agentId) → starts connection for an agent
 * - stopSession()         → explicitly closes connection
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAuthStore } from '../store/authStore';
import { STORAGE_KEYS, storage } from '../services/storage';

// Storage key for persisting voice session state
const VOICE_SESSION_KEY = 'teros_voice_session';

// =============================================================================
// TYPES
// =============================================================================

export type VoiceSessionState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface VoiceTranscript {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  type?: 'transcript' | 'tool_call' | 'tool_result' | 'tool_error';
}

export interface VoiceSession {
  /** Current conversation state */
  state: VoiceSessionState;
  /** Whether there is an active WebSocket connection */
  isConnected: boolean;
  /** agentId currently being spoken to, null if no active session */
  activeAgentId: string | null;
  /** Voice channel created by the backend */
  channelId: string | null;
  /** ElevenLabs conversation ID */
  conversationId: string | null;
  /** Accumulated transcripts for the session */
  transcripts: VoiceTranscript[];
  /** Microphone audio level (0-1) */
  audioLevel: number;
  /** ElevenLabs VAD score (0-1) */
  vadScore: number;
  /** Whether the microphone is muted */
  isMuted: boolean;
  /** Whether auto-reconnection is in progress */
  isReconnecting: boolean;
  /** Last persisted session (agentId + channelId) — available even when there is no active session */
  lastSession: { agentId: string; channelId: string; savedAt: number } | null;

  /** Starts a voice session with the given agent (optionally resuming a channel) */
  startSession: (agentId: string, resumeChannelId?: string) => Promise<void>;
  /** Stops the active session (explicitly — does not reconnect) */
  stopSession: () => void;
  /** Toggles microphone mute */
  toggleMute: () => void;
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
  const [state, setState] = useState<VoiceSessionState>('idle');
  const [isConnected, setIsConnected] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<VoiceTranscript[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  const [vadScore, setVadScore] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [lastSession, setLastSession] = useState<{ agentId: string; channelId: string; savedAt: number } | null>(null);

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
  const animationFrameRef = useRef<number | null>(null);
  const agentSpeakingRef = useRef(false);
  const isMutedRef = useRef(false);
  const stateRef = useRef<VoiceSessionState>('idle');
  // Reconnect control
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false); // true when user explicitly stops
  const activeAgentIdRef = useRef<string | null>(null);
  const activeChannelIdRef = useRef<string | null>(null);

  // Load persisted last session on mount
  useEffect(() => {
    storage.getItem(VOICE_SESSION_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setLastSession(parsed);
        } catch {}
      }
    });
  }, []);

  // Keep stateRef in sync (for use inside audio callbacks)
  useEffect(() => { stateRef.current = state; }, [state]);

  // Sync agentSpeaking flag to worklet when it changes
  useEffect(() => {
    workletNodeRef.current?.port.postMessage({ type: 'agentSpeaking', value: agentSpeakingRef.current });
  });

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  const addTranscript = useCallback((text: string, isUser: boolean, type?: VoiceTranscript['type']) => {
    setTranscripts((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${Math.random()}`,
        text,
        isUser,
        timestamp: Date.now(),
        type: type ?? 'transcript',
      },
    ]);
  }, []);

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
      source.connect(ctx.destination);
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
        playbackContextRef.current = new AudioContext({ sampleRate: 24000 });
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
      setAudioLevel(avg / 255);
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
  }, [monitorAudioLevel, sendPcmBuffer]);

  const stopAudioCapture = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
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

      case 'user_transcript':
        addTranscript(message.user_transcription_event?.user_transcript, true);
        break;

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
        // Persist session so we can resume later
        if (activeAgentIdRef.current && newChannelId) {
          const sessionData = {
            agentId: activeAgentIdRef.current,
            channelId: newChannelId,
            savedAt: Date.now(),
          };
          storage.setItem(VOICE_SESSION_KEY, JSON.stringify(sessionData)).catch(() => {});
          setLastSession(sessionData);
        }
        break;
      }

      case 'tool_call': {
        const toolName = message.toolName ?? 'send_message';
        let toolText = `🛠️ ${toolName}`;
        if (toolName === 'send_message' && message.message) {
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
        break;
      }

      case 'tool_result':
        addTranscript(message.text ?? '', false, 'tool_result');
        break;

      case 'tool_error':
        addTranscript(`❌ Error: ${message.error}`, false, 'tool_error');
        break;

      case 'interruption':
        if (activeSourceRef.current) {
          try { activeSourceRef.current.stop(); } catch {}
          activeSourceRef.current = null;
        }
        audioQueueRef.current = [];
        agentSpeakingRef.current = false;
        isPlayingRef.current = false;
        setState('listening');
        break;

      case 'error':
        console.error('[VoiceSession] Server error:', message.error);
        break;
    }
  }, [addTranscript, playAudio]);

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
      setChannelId(null);
      activeChannelIdRef.current = null;
      setConversationId(null);
      setTranscripts([]);
    }
    setVadScore(0);
    setIsMuted(false);
    isMutedRef.current = false;
    setState('idle');
  }, [stopAudioCapture, clearReconnectTimer]);

  // Core connect logic — separated so reconnect can call it too
  const connectWebSocket = useCallback(async (agentId: string, resumeChannelId?: string) => {
    if (!sessionToken) throw new Error('No session token');

    const baseWsUrl = process.env.EXPO_PUBLIC_WS_URL;
    if (!baseWsUrl) throw new Error('EXPO_PUBLIC_WS_URL is not defined');

    const url = new URL(baseWsUrl);
    url.pathname = '/voice';
    url.searchParams.set('sessionId', sessionToken);
    url.searchParams.set('agentId', agentId);
    if (resumeChannelId) {
      url.searchParams.set('channelId', resumeChannelId);
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
        console.error('[VoiceSession] Failed to start audio capture:', err);
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

      // Don't reconnect if intentional stop or normal closure
      if (intentionalStopRef.current || event.code === 1000) {
        setState('idle');
        return;
      }

      // Unexpected disconnect — attempt reconnect with backoff
      const agentToReconnect = activeAgentIdRef.current;
      const channelToResume = activeChannelIdRef.current;

      if (!agentToReconnect) {
        setState('idle');
        return;
      }

      const MAX_ATTEMPTS = 5;
      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;

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
        connectWebSocket(agentToReconnect, channelToResume ?? undefined).catch((err) => {
          console.error('[VoiceSession] Reconnect failed:', err);
        });
      }, delay);
    };
  }, [sessionToken, startAudioCapture, stopAudioCapture]);

  const startSession = useCallback(async (agentId: string, resumeChannelId?: string) => {
    if (!sessionToken) throw new Error('No session token');

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

    // Determine which channelId to use
    // Priority: explicit resumeChannelId > lastSession channelId (if same agent)
    let channelToResume = resumeChannelId;
    if (!channelToResume) {
      const saved = await storage.getItem(VOICE_SESSION_KEY);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.agentId === agentId) {
            channelToResume = parsed.channelId;
            console.log(`[VoiceSession] Auto-resuming last session channel: ${channelToResume}`);
          }
        } catch {}
      }
    }

    if (channelToResume) {
      activeChannelIdRef.current = channelToResume;
      // Don't clear transcripts when resuming
    } else {
      setTranscripts([]);
    }

    await connectWebSocket(agentId, channelToResume);
  }, [sessionToken, stopSession, connectWebSocket]);

  const toggleMute = useCallback(() => {
    isMutedRef.current = !isMutedRef.current;
    setIsMuted(isMutedRef.current);
    workletNodeRef.current?.port.postMessage({ type: 'mute', value: isMutedRef.current });
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
    state,
    isConnected,
    activeAgentId,
    channelId,
    conversationId,
    transcripts,
    audioLevel,
    vadScore,
    isMuted,
    isReconnecting,
    lastSession,
    startSession,
    stopSession,
    toggleMute,
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
