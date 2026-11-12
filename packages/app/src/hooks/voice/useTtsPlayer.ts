/**
 * useTtsPlayer — the native engine's audio player (Voice Mode v2, F3d) ⭐
 *
 * The native voice loop (voice-loop.ts, F1) sends the agent's voice as
 * `tts_chunk` frames: base64 slices of a 128 kbps 44.1 kHz MP3, ~3 KB per
 * frame, ONE INDEPENDENT MP3 PER SENTENCE (the ElevenLabs Flash provider
 * synthesizes sentence-by-sentence — ElevenLabsFlashTtsProvider), bracketed
 * by `speaking_started` / `speaking_ended` marks, and cut by `interrupt`
 * frames (barge-in, REQ-4).
 *
 * TECHNIQUE (decision, documented per the task):
 *   decodeAudioData + chained AudioBufferSourceNodes — NOT MediaSource.
 *
 *   Why: each sentence arrives as a COMPLETE, self-contained MP3 (own ID3
 *   header + Info/Xing block + frames — verified empirically against the
 *   real provider output). decodeAudioData handles that natively and robustly
 *   (it skips ID3/Info on its own). MediaSource+appendBuffer was rejected:
 *   fragmented-MP3 SourceBuffers are fragile cross-browser (Chrome demands a
 *   valid init segment, and concatenating per-sentence ID3s breaks the parser),
 *   and it gives no easy analyser tap for the orb's speaking ring.
 *
 * FRAMING (the subtle part — verified byte-by-byte against real provider
 * output): the backend slices each sentence MP3 into 3 KB tts_chunk frames,
 * so a sentence's MP3 spans MULTIPLE frames. The first frame of a sentence
 * starts with its own `ID3` tag (0x49 0x44 0x33) — that is the only reliable
 * sentence delimiter visible at the client. So the player ACCUMULATES bytes
 * per sentence and only decodes when the next sentence's ID3 arrives (or the
 * stream ends via `endSentence()` / `stop()`), guaranteeing every
 * decodeAudioData call receives a complete MP3.
 *
 * ORDER (the hard rule): strict FIFO. One AudioBufferSourceNode at a time,
 * chained through `onended`. The arrival order is the playback order — never
 * two audios at once. The backend already serializes sentences; the queue
 * defends against decode races (a later sentence can decode before an
 * earlier one on a busy main thread — buffers are queued, sources are not
 * started until the previous one ends).
 *
 * INTERRUPT (<300 ms perceived): `stop()` synchronously stops the in-flight
 * source (source.stop() is immediate), empties the queue AND the pending
 * sentence accumulator, and cancels in-flight decodes via a generation
 * counter (stale decode results are dropped). The backend already cancelled
 * the synthesis (F1b) — the client just stops playing.
 *
 * VOLUME/MUTE: a GainNode between each source and the destination — the
 * player's own channel volume. The mic worklet's mute (pcm-processor.js)
 * only gates CAPTURE; playback mute is this gain. `setMuted(true)` also
 * flushes in-flight audio (mute while speaking = "shut up" — same ceremony
 * as the legacy engine's interruption).
 *
 * ANALYSER (AC-UX2): every source routes through the caller-supplied
 * analyser node (the existing playbackAnalyserRef) so the orb's speaking
 * ring reflects REAL playback — no animation ever simulates absent audio.
 *
 * Platform: web-first (WebAudio). On surfaces without AudioContext the hook
 * degrades to a silent no-op — the same grace useEarcons gives (a missing
 * AudioContext must never break a voice session).
 *
 * Gated by the CALLER (VoiceSessionContext): only mounted when
 * `voice.engine === 'native'` — off = the legacy PCM pipeline is untouched
 * (zero regression).
 *
 * Tests: useTtsPlayer.render.test.ts (AudioContext mocked, the
 * useEarcons.render.test.ts pattern).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ─── Sentence framing ────────────────────────────────────────────────────────

/** First bytes of every ElevenLabs sentence MP3 — the sentence delimiter. */
const ID3_MAGIC = [0x49, 0x44, 0x33] as const; // "ID3"

/** True when a decoded tts_chunk payload starts a NEW sentence MP3. */
export function startsNewSentence(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === ID3_MAGIC[0] &&
    bytes[1] === ID3_MAGIC[1] &&
    bytes[2] === ID3_MAGIC[2]
  );
}

/** base64 → bytes (the frame's audio_base_64 payload). */
export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── The hook ────────────────────────────────────────────────────────────────

/** Character timing of one audio segment (times relative to the segment). */
export interface TtsAlignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

export interface UseTtsPlayerResult {
  /** Feed one `tts_chunk` frame (base64 mp3 bytes). Accumulates per sentence. */
  feedChunk: (base64Audio: string) => void;
  /**
   * PoC 2026-10-31: the chunks fed since the previous segment form one
   * decodable segment — decode it NOW (no waiting for the next sentence's
   * ID3) and remember its alignment for the spoken-text clock.
   */
  feedSegmentEnd: (alignment: TtsAlignment | null) => void;
  /** Ms of this turn's audio that have actually sounded so far. */
  getPositionMs: () => number;
  /** Characters of the turn's text already heard, per the alignment (0 if none). */
  getSpokenCharIndex: () => number;
  /** Characters the alignment covers so far (the TTS has got this far in the text). */
  getAlignedCharCount: () => number;
  /** `speaking_started` mark — (re)arms the player for a new turn. */
  onSpeakingStarted: () => void;
  /** `speaking_ended` mark — flushes the pending sentence into the queue. */
  onSpeakingEnded: () => void;
  /** `interrupt` frame / mute button — stop NOW: kill in-flight audio, empty everything. */
  stop: () => void;
  /** The player's channel mute (flushes in-flight audio too). */
  setMuted: (muted: boolean) => void;
  /** Whether audio is playing (in-flight source or queued buffers). */
  isPlaying: boolean;
  /**
   * Fires ONCE when the queue fully drains after a `speaking_ended` mark —
   * the "back to idle" edge. Not fired on `stop()` (an interrupt is not a
   * completion) nor while more chunks may still arrive.
   * Read via the ref at call time (getOnPlaybackEnded).
   */
  onPlaybackEnded: (() => void) | null;
  /** Set the drain callback (the caller's "back to idle" transition). */
  setOnPlaybackEnded: (cb: (() => void) | null) => void;
  /** PoC 2026-10-31: callback fired when the first source of a turn actually starts sounding. */
  setOnPlaybackStarted: (cb: (() => void) | null) => void;
  /** Read the currently registered drain callback (the latest closure). */
  getOnPlaybackEnded: () => (() => void) | null;
  /**
   * The player's own analyser (AC-UX2) — created on first use. The caller
   * polls it (getByteFrequencyData) to drive the orb's speaking ring with
   * REAL playback. Null while no WebAudio is available.
   */
  getAnalyser: () => AnalyserNode | null;
  /**
   * F5g: resume the underlying AudioContext if the browser suspended it.
   * Chrome can suspend a page's AudioContexts when the tab is hidden or the
   * OS throttles it — the queue keeps draining (onended fires) but NOTHING
   * SOUNDS. The caller invokes this on `visibilitychange → visible` (and
   * anywhere it suspects a suspension) so the agent's voice is never lost
   * to a silent context. Safe no-op when running, closed or absent.
   */
  resume: () => void;
}

export function useTtsPlayer(options?: {
  /** Destination the sources route through. Default: a fresh context's destination. */
  destination?: AudioNode;
  /** Own AudioContext (e.g. the session's playbackContextRef). Created lazily when omitted. */
  audioContext?: AudioContext;
}): UseTtsPlayerResult {
  // Bytes of the sentence currently arriving (spans multiple tts_chunk frames).
  const pendingRef = useRef<Uint8Array | null>(null);
  // Decoded segments waiting to play — strict FIFO, each with its char timing.
  const queueRef = useRef<Array<{ buffer: AudioBuffer; alignment: TtsAlignment | null }>>([]);
  // Decodes are serialized so a short later segment can never overtake a
  // long earlier one (text order = playback order).
  const decodeChainRef = useRef<Promise<void>>(Promise.resolve());
  // Playback clock of the current turn: audio fully played + the live source.
  const turnPlayedMsRef = useRef(0);
  const sourceStartedAtRef = useRef<number | null>(null); // ctx.currentTime at source.start()
  const activeDurationMsRef = useRef(0);
  // Character timeline of the turn: absolute start (ms) of every aligned char.
  const charStartsRef = useRef<number[]>([]);
  // The one source allowed to sound at a time.
  const activeSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const playingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  // Generation counter — bumped on stop(); stale decode results are dropped.
  const generationRef = useRef(0);
  const mutedRef = useRef(false);
  const volumeRef = useRef(1);
  // True between onSpeakingEnded and the queue's full drain — gates the
  // "back to idle" callback (the turn's audio is still sounding).
  const streamEndedRef = useRef(false);
  // Decodes kicked off but not yet resolved. The "back to idle" edge must
  // NOT fire while a decode is in flight — the audio it will produce has
  // not sounded yet (activeSourceRef is null until the first decode lands,
  // so the drain condition alone would fire prematurely).
  const pendingDecodesRef = useRef(0);
  // The caller's drain callback ("back to idle"), kept in a ref ONLY —
  // never in useState: a callback in state can be invoked by React as a
  // functional updater (dispatchSetState calls it during the render),
  // firing the edge spuriously at mount. The ref is the single source.
  const onPlaybackEndedRef = useRef<(() => void) | null>(null);
  /** PoC trace: fires when the first buffer of a turn starts sounding. */
  const onPlaybackStartedRef = useRef<(() => void) | null>(null);

  // The context + routing (source → analyser → gain → destination).
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  // The player's OWN analyser — the orb's speaking ring reads REAL playback
  // through it (AC-UX2). Created with the graph; exposed via getAnalyser().
  const analyserRef = useRef<AnalyserNode | null>(null);
  const ownContextRef = useRef(false);

  /** Lazily create (or adopt) the AudioContext + routing chain. */
  const getGraph = useCallback((): {
    ctx: AudioContext;
    input: AudioNode;
  } | null => {
    if (typeof window === 'undefined') return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null; // no WebAudio on this surface — silent no-op

    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      try {
        ctxRef.current = options?.audioContext ?? new Ctor();
        ownContextRef.current = !options?.audioContext;
      } catch {
        return null; // construction can throw (autoplay policies) — degrade
      }
    }
    const ctx = ctxRef.current;

    if (!gainRef.current) {
      try {
        const gain = ctx.createGain();
        gain.gain.value = mutedRef.current ? 0 : volumeRef.current;
        gainRef.current = gain;
      } catch {
        return null;
      }
    }
    // The player's own analyser (AC-UX2) — part of the chain from the start.
    if (!analyserRef.current) {
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
      } catch {
        analyserRef.current = null;
      }
    }
    // SERIES chain: gain → analyser → destination. The analyser sits AFTER
    // the gain, so it reads the REAL post-gain playback level — mute
    // silences the audio AND rests the orb's ring (AC-UX2: no simulated
    // audio) — and the destination hears the playback exactly ONCE (a
    // parallel tap would double it and bypass the mute). connect() is
    // idempotent for an already-wired pair, so re-running is safe.
    try {
      if (analyserRef.current) {
        gainRef.current.connect(analyserRef.current);
        analyserRef.current.connect(options?.destination ?? ctx.destination);
      } else {
        gainRef.current.connect(options?.destination ?? ctx.destination);
      }
    } catch {
      // Degraded wiring — routeSource's own fallback still sounds.
    }
    return { ctx, input: gainRef.current };
  }, [options?.audioContext, options?.destination]);

  /**
   * The player's analyser (AC-UX2): created with the graph and wired IN
   * SERIES (gain → analyser → destination) by getGraph — it reads the REAL
   * post-gain playback level. The caller polls it (getByteFrequencyData)
   * to drive the orb's speaking ring — never a simulated animation.
   */
  const getAnalyser = useCallback((): AnalyserNode | null => {
    if (analyserRef.current) return analyserRef.current;
    // Not created yet — building the graph creates + wires it.
    return getGraph() ? analyserRef.current : null;
  }, [getGraph]);

  /**
   * Route a source into the chain. The SERIES wiring (source → gain →
   * analyser → destination) is built by getGraph — the source only needs
   * the gain (input). The analyser reads the REAL post-gain level, so a
   * muted gain silences both the audio AND the orb's ring (AC-UX2).
   */
  const routeSource = useCallback(
    (_ctx: AudioContext, source: AudioBufferSourceNode, input: AudioNode) => {
      try {
        source.connect(input);
      } catch {
        try { source.connect(_ctx.destination); } catch { /* nothing more to do */ }
      }
    },
    [],
  );

  /** Drain the queue — ONE source at a time, chained via onended (FIFO). */
  const drainQueue = useCallback(() => {
    const graph = getGraph();
    if (!graph) {
      // No WebAudio: discard the queue (silent degradation, never a crash).
      queueRef.current = [];
      playingRef.current = false;
      setIsPlaying(false);
      return;
    }
    const { ctx, input } = graph;

    if (activeSourceRef.current) return; // never two audios at once
    const next = queueRef.current.shift();
    if (!next) {
      if (playingRef.current) {
        playingRef.current = false;
        setIsPlaying(false);
      }
      // The turn's audio fully drained (the stream already ended) → the
      // "back to idle" edge. Fire ONCE — the flag re-arms on the next
      // onSpeakingStarted.
      if (streamEndedRef.current) {
        streamEndedRef.current = false;
        try { onPlaybackEndedRef.current?.(); } catch { /* never break playback */ }
      }
      return;
    }

    if (!playingRef.current) {
      playingRef.current = true;
      setIsPlaying(true);
      try { onPlaybackStartedRef.current?.(); } catch { /* never break playback */ }
    }

    const source = ctx.createBufferSource();
    source.buffer = next.buffer;
    routeSource(ctx, source, input);
    activeSourceRef.current = source;
    // Clock + timeline: this segment starts where the played audio ends.
    const offsetMs = turnPlayedMsRef.current;
    activeDurationMsRef.current = next.buffer.duration * 1000;
    if (next.alignment) {
      // ElevenLabs char times are cumulative over the stream (measured
      // 2026-10-31), so they already sit on this clock; add the offset only
      // for a provider that sends per-segment times (first start far below
      // the audio already played).
      const { charStartTimesMs } = next.alignment;
      const base = offsetMs > 500 && charStartTimesMs[0] < offsetMs * 0.5 ? offsetMs : 0;
      for (let i = 0; i < charStartTimesMs.length; i++) {
        charStartsRef.current.push(base + charStartTimesMs[i]);
      }
    }

    source.onended = () => {
      // Only advance the chain if this source is still the active one —
      // a stale onended (after stop() replaced/killed it) must not resurrect
      // the queue.
      if (activeSourceRef.current === source) {
        activeSourceRef.current = null;
        turnPlayedMsRef.current = offsetMs + activeDurationMsRef.current;
        sourceStartedAtRef.current = null;
        drainQueue();
      }
    };
    try {
      source.start();
      sourceStartedAtRef.current = ctx.currentTime;
    } catch {
      // start() on a closed context — drop this buffer, try the next.
      activeSourceRef.current = null;
      drainQueue();
    }
  }, [getGraph, routeSource]);

  /** Decode the accumulated segment bytes and queue the buffer (FIFO, in order). */
  const flushPending = useCallback((alignment: TtsAlignment | null = null) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending || pending.length === 0) return;

    const graph = getGraph();
    if (!graph) return; // silent degradation
    const { ctx } = graph;
    const generation = generationRef.current;

    // Copy into a plain ArrayBuffer — decodeAudioData detaches its input.
    const copy = new ArrayBuffer(pending.byteLength);
    new Uint8Array(copy).set(pending);
    pendingDecodesRef.current += 1;

    const decodeNow = (): Promise<AudioBuffer> =>
      typeof ctx.decodeAudioData === 'function'
        ? new Promise((resolve, reject) => {
            // Callback form + promise form — cover old Safari too.
            try {
              const maybePromise = ctx.decodeAudioData(
                copy,
                (buf) => resolve(buf),
                (err) => reject(err ?? new Error('decodeAudioData failed')),
              );
              if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then(resolve, reject);
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })
        : Promise.reject(new Error('decodeAudioData unavailable'));

    // Serialized: this segment decodes after the previous one resolved.
    const decode = decodeChainRef.current.then(decodeNow, decodeNow);
    decodeChainRef.current = decode.then(() => undefined, () => undefined);

    decode
      .then((buffer) => {
        pendingDecodesRef.current = Math.max(0, pendingDecodesRef.current - 1);
        // Interrupted while decoding → drop (the backend already cancelled).
        if (generationRef.current !== generation) return;
        queueRef.current.push({ buffer, alignment });
        drainQueue();
      })
      .catch((err) => {
        pendingDecodesRef.current = Math.max(0, pendingDecodesRef.current - 1);
        if (generationRef.current !== generation) return;
        // A sentence that fails to decode is skipped — one bad sentence
        // must never stall the turn (the next sentences keep flowing).
        console.warn('[useTtsPlayer] sentence decode failed — skipping:', err);
        // The skipped sentence may have been the last: check the drain.
        drainQueue();
      });
  }, [getGraph, drainQueue]);

  // ── The frame handlers ──────────────────────────────────────────────────

  const feedChunk = useCallback(
    (base64Audio: string) => {
      if (!base64Audio) return;
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64ToBytes(base64Audio);
      } catch {
        console.warn('[useTtsPlayer] bad base64 tts_chunk — dropped');
        return;
      }

      // A new sentence's ID3 closes the previous one — that's the delimiter
      // (the backend slices one MP3 per sentence into ~3 KB frames).
      if (pendingRef.current && startsNewSentence(bytes)) {
        flushPending();
      }
      if (!pendingRef.current) {
        pendingRef.current = bytes;
      } else {
        const merged = new Uint8Array(pendingRef.current.length + bytes.length);
        merged.set(pendingRef.current, 0);
        merged.set(bytes, pendingRef.current.length);
        pendingRef.current = merged;
      }
    },
    [flushPending],
  );

  /** Segment boundary from the server: decode what arrived, with its timing. */
  const feedSegmentEnd = useCallback(
    (alignment: TtsAlignment | null) => {
      if (!pendingRef.current) return;
      flushPending(alignment);
    },
    [flushPending],
  );

  const getPositionMs = useCallback((): number => {
    const ctx = ctxRef.current;
    const live =
      activeSourceRef.current && ctx && sourceStartedAtRef.current !== null
        ? Math.min(activeDurationMsRef.current, (ctx.currentTime - sourceStartedAtRef.current) * 1000)
        : 0;
    return turnPlayedMsRef.current + live;
  }, []);

  const getSpokenCharIndex = useCallback((): number => {
    const starts = charStartsRef.current;
    if (starts.length === 0) return 0;
    const pos = getPositionMs();
    let n = 0;
    while (n < starts.length && starts[n] <= pos) n++;
    return n;
  }, [getPositionMs]);

  const getAlignedCharCount = useCallback((): number => {
    // Chars whose segment is queued or playing (not yet counted: segments
    // still decoding). Good enough for the muted tail of the live bubble.
    let n = charStartsRef.current.length;
    for (const item of queueRef.current) n += item.alignment?.chars.length ?? 0;
    return n;
  }, []);

  const onSpeakingStarted = useCallback(() => {
    // A new turn: drop any half-arrived sentence from the previous turn —
    // the backend guarantees speaking_started precedes the first chunk.
    pendingRef.current = null;
    // Re-arm the drain edge: the next speaking_ended starts a new drain.
    streamEndedRef.current = false;
    // Fresh clock + timeline for the new turn.
    turnPlayedMsRef.current = 0;
    sourceStartedAtRef.current = null;
    activeDurationMsRef.current = 0;
    charStartsRef.current = [];
  }, []);

  const onSpeakingEnded = useCallback(() => {
    // The stream ended — the last sentence is complete: decode + queue it.
    // The "back to idle" edge fires when the queue DRAINS (drainQueue),
    // not here — the audio the user is still hearing is real.
    streamEndedRef.current = true;
    flushPending();
    // Edge case: nothing was ever queued AND no decode is in flight (e.g.
    // the turn was cut before any audio) — drain immediately so the caller
    // still gets its "back to idle" edge. A pending decode means audio is
    // still coming: the edge must wait for it (drainQueue checks again).
    if (
      !activeSourceRef.current &&
      queueRef.current.length === 0 &&
      !pendingRef.current &&
      pendingDecodesRef.current === 0
    ) {
      streamEndedRef.current = false;
      playingRef.current = false;
      setIsPlaying(false);
      try { onPlaybackEndedRef.current?.(); } catch { /* never break playback */ }
    }
  }, [flushPending]);

  const stop = useCallback(() => {
    // 1. Kill the in-flight source NOW (<300 ms perceived — source.stop()
    //    silences on the spot; the backend already cancelled the synthesis).
    const source = activeSourceRef.current;
    activeSourceRef.current = null;
    if (source) {
      source.onended = null; // the chain must not resurrect from its own death
      try { source.stop(); } catch { /* already stopped — expected */ }
      try { source.disconnect(); } catch { /* ignore */ }
    }
    // 2. Empty everything: queued buffers + the half-arrived sentence.
    queueRef.current = [];
    pendingRef.current = null;
    // 3. Invalidate in-flight decodes (generation bump) and the drain edge —
    //    an interrupt is NOT a completion: onPlaybackEnded must not fire.
    generationRef.current += 1;
    streamEndedRef.current = false;
    pendingDecodesRef.current = 0; // their results are dropped anyway
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  const setMuted = useCallback(
    (muted: boolean) => {
      mutedRef.current = muted;
      if (gainRef.current) {
        try {
          gainRef.current.gain.value = muted ? 0 : volumeRef.current;
        } catch { /* ignore */ }
      }
      // Mute while speaking is a cut — same ceremony as the legacy engine.
      if (muted) stop();
    },
    [stop],
  );

  // Close the context we OWN (never the caller-supplied one).
  useEffect(() => {
    return () => {
      const source = activeSourceRef.current;
      if (source) {
        try { source.stop(); } catch { /* ignore */ }
      }
      activeSourceRef.current = null;
      queueRef.current = [];
      pendingRef.current = null;
      generationRef.current += 1;
      streamEndedRef.current = false;
      if (ownContextRef.current && ctxRef.current) {
        try { ctxRef.current.close(); } catch { /* ignore */ }
      }
      ctxRef.current = null;
      gainRef.current = null;
    };
  }, []);

  const setOnPlaybackEnded = useCallback((cb: (() => void) | null) => {
    onPlaybackEndedRef.current = cb;
  }, []);

  const setOnPlaybackStarted = useCallback((cb: (() => void) | null) => {
    onPlaybackStartedRef.current = cb;
  }, []);

  /** Read the registered drain callback (the latest closure). */
  const getOnPlaybackEnded = useCallback(() => onPlaybackEndedRef.current, []);

  // ── F5g: background resilience ──────────────────────────────────────────
  // The browser may suspend this player's AudioContext while the tab is
  // hidden (Chrome does it opportunistically; timers throttle, RAF stops).
  // The queue keeps draining — onended still fires — but nothing sounds.
  // The caller (VoiceSessionContext) calls resume() when the tab becomes
  // visible again, so the agent's voice is never lost to a silent context.
  // Safe no-op when running, closed or absent — never throws, never breaks.
  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state !== 'suspended') return;
    ctx.resume().catch((err: unknown) => {
      // Autoplay policy or a racing close() — degrade silently: the next
      // drainQueue/getGraph may still recover the context.
      console.warn('[useTtsPlayer] ctx.resume() failed (background return):', err);
    });
  }, []);

  return {
    feedChunk,
    feedSegmentEnd,
    getPositionMs,
    getSpokenCharIndex,
    getAlignedCharCount,
    onSpeakingStarted,
    onSpeakingEnded,
    stop,
    setMuted,
    isPlaying,
    onPlaybackEnded: onPlaybackEndedRef.current,
    setOnPlaybackEnded,
    setOnPlaybackStarted,
    getOnPlaybackEnded,
    getAnalyser,
    resume,
  };
}
