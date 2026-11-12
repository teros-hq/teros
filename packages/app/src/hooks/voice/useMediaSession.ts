/**
 * useMediaSession — AirPods / media-key play-pause → mic mute toggle (F5i) ⭐
 *
 * Pablo's ask (2026-10-05, live): the AirPods stem button (play/pause) should
 * mute/unmute his mic during a Teros voice session — "the iPhone phone mode
 * already does this". The Teros voice session is a WEB session (not a system
 * call), so the stem button arrives as a media-controls event at the browser —
 * the Media Session API is the door.
 *
 * WHAT THE HOOK DOES while a session is active (native engine only):
 *
 *   1. CLAIMS the now-playing session:
 *        navigator.mediaSession.metadata = new MediaMetadata({
 *          artist: 'Teros', title: '<agent> — sesión de voz', album: 'Teros' })
 *        navigator.mediaSession.playbackState = 'playing'
 *      playbackState stays 'playing' for the WHOLE session — whether or not
 *      the TTS is sounding. It is what keeps the hardware buttons routed to
 *      us instead of Spotify.
 *
 *   2. MAPS the buttons: `setActionHandler('play', fn)` AND
 *      `setActionHandler('pause', fn)` → BOTH to the same `onToggleMute`
 *      (toggle semantics — robust against whatever the OS sends: if
 *      playbackState stays 'playing', the OS always sends 'pause'; the toggle
 *      works either way). The handler is OURS: a press while the agent speaks
 *      toggles the mic and NEVER pauses the TTS.
 *
 *   2b. MIC-CONTROL PROBE (F5i-c, live evidence 19:15): with getUserMedia
 *      live, iOS classifies the session as CALL-LIKE and routes the stem
 *      press to mic-control — the Dynamic Island then shows "No se puede
 *      controlar el micrófono con los AirPods 4 (ANC)" (an iOS toast, not a
 *      web one — a web page cannot accept call-routing commands). IF Safari
 *      exposes the `togglemicrophone` media-session action, registering it
 *      captures that intent AT the page: the press arrives as our
 *      toggleMute — the cleanest door. Feature-detected at runtime: an
 *      implementation without the action throws on register → logged
 *      fallback, nothing breaks; play/pause stay the universal doors.
 *      Honest expectation: iOS may keep the stem for call-control even with
 *      audio sounding (Apple reserves that routing during mic-active
 *      sessions; Safari documents no override) — if so, the lock-screen
 *      play/pause button (a UI button — it DOES route to the page) and the
 *      Mac media keys remain the working doors.
 *
 *   3. KEEP-ALIVE: during silences (TTS stopped) the OS could hand the
 *      now-playing session to another app. Standard fix: a looping
 *      <audio> (public/near-silence.wav) started with the session and
 *      stopped with it — it keeps the media session alive. Needed on iOS
 *      Safari (definitely) and harmless on Chrome desktop.
 *
 *      F5i-b (2026-10-05, live bug found by Pablo): the keep-alive used to
 *      play a true-silence WAV at volume 0 — Safari AND Chrome treat
 *      volume-0/muted audio as INAUDIBLE and refuse to route media-button
 *      ACTIONS to it (the now-playing card still shows, but the stem press
 *      gets the iOS "unhandled action" triple beep). Fix: the WAV carries
 *      amplitude 1 (the LSB, ~-96dB — inaudible to the ear, AUDIBLE to the
 *      browser's audibility check) and the element plays at volume 1.0,
 *      unmuted. The inaudibility lives in the file, not in the element.
 *
 *      F5i-c (2026-10-05, live bug found by Pablo): even with the right WAV
 *      the keep-alive NEVER sounded on iOS — the play() ran in the effect,
 *      OUTSIDE the user-gesture call stack, and Safari iOS rejects the
 *      FIRST play() of an element outside a gesture; the swallowed
 *      rejection (an empty catch) left the session unrouted: no sounding
 *      audio → Safari never owns "now playing" → the stem press falls
 *      through to the iOS triple beep (the lock-screen card still shows —
 *      it is only metadata; that is why the symptom was deceptive). Fix:
 *      GESTURE-UNLOCK — the rejection is logged (never silent again) and
 *      every pointerdown retries the play: inside the gesture Safari
 *      allows it, and during a voice session the user taps constantly, so
 *      the unlock lands on the first tap. The retry listener drops itself
 *      the moment the audio sounds; a visibilitychange retry (the F5g
 *      pattern) covers Safari suspending the audio in background.
 *
 *   4. RELEASES on stop: metadata → null, playbackState → 'none', handlers →
 *      null, keep-alive paused + src cleared (no zombie audio) and the
 *      unlock/retry listeners dropped (no zombie listeners — F5i-c). The
 *      buttons go back to controlling whatever else was playing.
 *
 * BONUS (free, included): with metadata + playbackState set, iOS shows
 * "Teros" with a play/pause button on the LOCK SCREEN — pressing it there
 * fires the same toggleMute. macOS media keys (F8) and the AirPods stem
 * arrive through the same handlers.
 *
 * NOT MAPPED (open question, deliberately):
 *   - nexttrack / previoustrack (double/triple stem press) — could map to a
 *     listening-mode change in the future. Left unhandled for now.
 *     // @todo iria - 2026.10.05 : next/prev track (double/triple AirPods
 *     press) could map to cycling the listening mode — decide with Pablo.
 *
 * Platform: web-only (Media Session API is a browser API). On native there is
 * no navigator.mediaSession — the hook degrades to a silent no-op, the same
 * grace useEarcons gives. A missing API must NEVER break a voice session.
 *
 * Gated by the CALLER (VoiceSessionContext): only wired when
 * `voice.engine === 'native'` AND a session is active — off = nothing is ever
 * claimed (legacy path untouched, zero regression).
 *
 * Tests: useMediaSession.render.test.ts (navigator.mediaSession mocked, the
 * useEarcons.render.test.ts pattern).
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/**
 * The near-silent loop that keeps the now-playing session alive (public/).
 * PCM 16-bit mono 8kHz, 1s, every sample = 1 (the LSB, ~-96dB) — NOT zeros:
 * a true-silence file at volume 0 is "inaudible" to Safari/Chrome, which then
 * refuse to route media-button actions to us (F5i-b). The inaudibility lives
 * in the file; the element plays it at full volume, unmuted.
 */
const SILENCE_SRC = '/near-silence.wav';

/** Narrow local view of navigator.mediaSession (the DOM lib types it loosely). */
interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler: (action: string, handler: (() => void) | null) => void;
}

function getMediaSession(): MediaSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession;
  return ms ?? null;
}

/** True when the global MediaMetadata constructor exists (claimable). */
function hasMediaMetadata(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as unknown as { MediaMetadata?: unknown }).MediaMetadata === 'function';
}

export interface UseMediaSessionArgs {
  /** Claim the now-playing session while true (native engine + live session). */
  active: boolean;
  /** Agent display name for the metadata title ("<agent> — sesión de voz"). */
  agentName: string;
  /** Fired on play/pause hardware media events — the mic mute toggle. */
  onToggleMute: () => void;
}

/**
 * Claims/releases the browser media session for the voice session.
 *
 * `active` false → everything released and cleaned (handlers null, keep-alive
 * stopped, metadata cleared). Re-renders with the same `active` are cheap —
 * the claim only re-runs when the deps actually change.
 */
export function useMediaSession({ active, agentName, onToggleMute }: UseMediaSessionArgs): void {
  // The toggle closure changes every render (VoiceSessionContext recreates
  // it) — read it through a ref so the document-level handlers registered
  // ONCE always call the latest one (the ttsPlayerRef pattern, F5g).
  const onToggleMuteRef = useRef(onToggleMute);
  onToggleMuteRef.current = onToggleMute;

  useEffect(() => {
    // Web-only API — native surfaces have no mediaSession to claim.
    if (Platform.OS !== 'web') return;
    const ms = getMediaSession();
    if (!ms || !hasMediaMetadata()) return;
    // Nothing to claim without a live session — release and leave.
    if (!active) {
      release(ms);
      return;
    }

    // ── 1. CLAIM ────────────────────────────────────────────────────────────
    // The now-playing card: "Teros · <agent> — sesión de voz". This is what
    // the OS shows (lock screen, control center, media key routing) and what
    // keeps the hardware buttons pointed at us.
    const MediaMetadataCtor = (globalThis as unknown as {
      MediaMetadata: new (init: { title?: string; artist?: string; album?: string }) => unknown;
    }).MediaMetadata;
    ms.metadata = new MediaMetadataCtor({
      artist: 'Teros',
      title: `${agentName} — sesión de voz`,
      album: 'Teros',
    });
    // 'playing' for the WHOLE session (TTS sounding or not) — the routing
    // signal. The OS then always sends 'pause' on the stem press; our toggle
    // semantics make that irrelevant.
    ms.playbackState = 'playing';

    // ── 2. BUTTONS → toggleMute ────────────────────────────────────────────
    // Both actions, same toggle. The handler decides what a press means —
    // the mic toggles, the TTS is NEVER paused (mute ≠ shut up).
    ms.setActionHandler('play', () => onToggleMuteRef.current());
    ms.setActionHandler('pause', () => onToggleMuteRef.current());
    // nexttrack/previoustrack deliberately NOT set (open question above).

    // ── 2b. MIC-CONTROL PROBE (F5i-c, live evidence 19:15) ──────────────────
    // With getUserMedia live iOS classifies the session as CALL-LIKE and
    // routes the stem press to mic-control (the Dynamic Island toast "No se
    // puede controlar el micrófono con los AirPods 4 (ANC)" is iOS, not web).
    // IF Safari exposes the `togglemicrophone` media-session action, this
    // captures the intent AT the page: the press arrives as our toggleMute —
    // the cleanest door. Feature-detected: an implementation without the
    // action throws on register → logged fallback, nothing breaks (the
    // no-empty-catch rule — the fallback is a logged debug, not a swallow).
    let micControlCaptured = false;
    try {
      ms.setActionHandler('togglemicrophone', () => onToggleMuteRef.current());
      micControlCaptured = true;
      console.log('[useMediaSession] togglemicrophone action registered (iOS mic-control intent captured)');
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string } | undefined;
      console.warn(
        '[useMediaSession] togglemicrophone action not supported — iOS keeps call-control routing; the stem may stay intercepted:',
        e?.name,
        e?.message,
      );
    }

    // ── 3. KEEP-ALIVE ──────────────────────────────────────────────────────
    // A looping <audio> so the OS never hands the now-playing session to
    // another app during our silences. Created imperatively (a ref-held
    // element, not JSX) — it is session plumbing, not UI.
    let keepAlive: HTMLAudioElement | null = null;
    // F5i-c gesture-unlock plumbing — declared OUTSIDE the try so the release
    // can always drop the listeners, even when the element never materialized.
    let unlockOnPointerDown: (() => void) | null = null;
    let unlockOnVisible: (() => void) | null = null;
    try {
      keepAlive = document.createElement('audio');
      keepAlive.src = SILENCE_SRC;
      keepAlive.loop = true;
      // F5i-b: volume 1.0, NOT 0 — volume-0/muted audio is "inaudible" to
      // Safari/Chrome and they refuse to route media-button ACTIONS to it
      // (now-playing card shows, stem press → iOS triple beep). The file
      // itself is near-silent (every sample = 1, the LSB) — the ear hears
      // nothing, the browser's audibility check passes. No muted either:
      // same class of problem.
      keepAlive.volume = 1;

      // F5i-c: the autoplay-policy comment that used to live here ("the
      // session starts from a user gesture, so play() is allowed") was WRONG
      // for iOS: this play() runs in the effect, OUTSIDE the gesture's call
      // stack (the tap that started the session happened before the effect
      // ran), and Safari iOS requires the FIRST play() of an element to occur
      // synchronously inside a gesture handler. The rejection is NOT swallowed
      // anymore — it is logged, and the gesture-unlock below retries.

      // Disarm the gesture-unlock: the element has sounded once — it stays
      // unlocked for the session's lifetime, no tap needed ever again.
      const dropPointerDownUnlock = (): void => {
        if (unlockOnPointerDown) {
          document.removeEventListener('pointerdown', unlockOnPointerDown);
          unlockOnPointerDown = null;
        }
      };

      // The single play() door — every retry (initial, tap, visible) goes
      // through it so the rejection logging lives in ONE place.
      const tryPlay = (): void => {
        if (!keepAlive || !keepAlive.paused) return;
        keepAlive
          .play()
          .then(() => {
            // Sounded — disarm the tap-unlock (a later pause is a Safari
            // suspension, covered by the visibilitychange retry below).
            dropPointerDownUnlock();
          })
          .catch((err?: { name?: string; message?: string }) => {
            // F5i-c: VISIBLE, not swallowed — this is the line that was
            // missing when the keep-alive silently never sounded on iOS.
            console.warn(
              '[useMediaSession] keep-alive play rejected (will retry on next tap):',
              err?.name,
              err?.message,
            );
          });
      };
      tryPlay(); // best effort — inside a gesture Safari allows it, outside iOS rejects it

      // GESTURE-UNLOCK (F5i-c): while the element has never sounded, every
      // pointerdown retries the play — INSIDE the gesture Safari allows it.
      // During a voice session the user taps the screen constantly (orb,
      // popover, anything), so the unlock lands on the first tap. Armed only
      // while there is something to unlock: if the initial play already
      // succeeded (desktop/Chrome, or a Safari that allowed it), the listener
      // is never registered — and it drops itself the moment the play
      // succeeds, so a healthy session carries no tap listener at all.
      if (keepAlive.paused) {
        unlockOnPointerDown = () => {
          if (!keepAlive) return;
          if (!keepAlive.paused) {
            dropPointerDownUnlock(); // already sounding — nothing to unlock
            return;
          }
          tryPlay(); // inside the gesture — Safari allows it
        };
        document.addEventListener('pointerdown', unlockOnPointerDown);
        console.log('[useMediaSession] Keep-alive blocked — gesture-unlock armed (any tap starts it)');
      }

      // VISIBILITYCHANGE retry (the F5g pattern): Safari may suspend the
      // audio when the page goes to background; coming back visible retries
      // the play — by then the element has already played once inside a
      // gesture, so no gesture is needed. Armed for the WHOLE session
      // (suspension can happen long after a healthy start), dies with the
      // release — while the audio sounds it is a no-op (paused === false).
      unlockOnVisible = () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
        if (!keepAlive || !keepAlive.paused) return;
        tryPlay();
      };
      document.addEventListener('visibilitychange', unlockOnVisible);
    } catch {
      // createElement/play unavailable — the claim still holds; the keep-alive
      // is best-effort.
    }

    console.log(`[useMediaSession] Claimed media session (${agentName}) — play/pause → mic mute`);

    // ── 4. RELEASE ─────────────────────────────────────────────────────────
    return () => {
      // F5i-c: the unlock/retry listeners die with the session — no zombies
      // after a hang-up (a leaked pointerdown listener would retry a play
      // on every future tap, forever; a leaked visibilitychange one on
      // every future tab switch).
      if (unlockOnPointerDown) document.removeEventListener('pointerdown', unlockOnPointerDown);
      if (unlockOnVisible) document.removeEventListener('visibilitychange', unlockOnVisible);
      if (keepAlive) {
        try {
          keepAlive.pause();
          keepAlive.removeAttribute('src');
          keepAlive.load(); // drop the buffer — no zombie audio
        } catch { /* already gone */ }
      }
      release(ms, micControlCaptured);
      console.log('[useMediaSession] Released media session');
    };
    // agentName in deps: a session for another agent re-claims with the new
    // title. active gates everything else.
  }, [active, agentName]);
}

/** Clear the claim: metadata, playbackState, handlers — the OS is free again. */
function release(ms: MediaSessionLike, micControlCaptured = false): void {
  try {
    ms.metadata = null;
    ms.playbackState = 'none';
    ms.setActionHandler('play', null);
    ms.setActionHandler('pause', null);
    // Only cleared when it was captured — calling setActionHandler on an
    // unsupported action could throw again on release (the same hostile
    // implementation), and the whole try would die before the OS is freed.
    if (micControlCaptured) ms.setActionHandler('togglemicrophone', null);
  } catch {
    // A hostile/odd implementation — nothing to do; the session dies anyway.
  }
}
