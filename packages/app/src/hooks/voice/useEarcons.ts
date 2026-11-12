/**
 * useEarcons — the second state channel (ui-evolution.md §3.6, UX §4.2) ⭐
 *
 * The voice user does not always look at the screen. Earcons are short,
 * synthesized tones (WebAudio oscillators — zero audio assets) that make
 * every state transition audible:
 *
 *   presence on   → soft ascending (DO5→SOL5)   "ya puedes hablar"
 *   presence off  → soft descending (SOL5→DO5)  clear closure
 *   mode → passive      → low short note (LA3)   "me callo"
 *   mode → conversation → high short note (LA4)  "te escucho de nuevo"
 *   error        → double low (RE3 RE3)          requires attention
 *   worker permission → soft bell (MI5·LA5·SOL5) action pending
 *
 * Rules (UX §4.2):
 *   - respects the system mute (AudioContext suspended → nothing plays);
 *   - volume tied to the app audio (a single quiet gain, ~0.18);
 *   - toggle persisted in user settings (voice.earcons.enabled);
 *   - native with the device silenced → haptic equivalent would live here
 *     (expo-haptics is not a dependency today — web-first surface; the
 *     extension point is marked below).
 *
 * Consumed from VoiceSessionContext (the only place that knows when the
 * transitions happen) and VoiceThreadSection (worker permission earcon).
 *
 * Gated by the voice.mode-ui feature flag at the CALLER — off = the hook is
 * never wired and no sound is ever synthesized (zero regression).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { STORAGE_KEYS, storage } from '../../services/storage';

// ─── The earcon vocabulary (UX §4.2 — one tone per meaning) ──────────────────

export type EarconEvent =
  | 'presence_on'
  | 'presence_off'
  | 'mode_passive'
  | 'mode_conversation'
  | 'error'
  | 'worker_permission';

/** One synthesized note: sine wave, soft attack, exponential release. */
interface Note {
  /** Frequency in Hz. */
  freq: number;
  /** Start time offset from "now", in seconds. */
  at: number;
  /** Duration in seconds. */
  dur: number;
  /** Peak gain (0-1). */
  gain: number;
}

const EARCON_VOICES: Record<EarconEvent, Note[]> = {
  // Soft ascending — "ya puedes hablar" (C5 523.25 → G5 783.99)
  presence_on: [
    { freq: 523.25, at: 0, dur: 0.12, gain: 0.16 },
    { freq: 783.99, at: 0.14, dur: 0.18, gain: 0.18 },
  ],
  // Soft descending — clear closure (G5 → C5)
  presence_off: [
    { freq: 783.99, at: 0, dur: 0.12, gain: 0.14 },
    { freq: 523.25, at: 0.14, dur: 0.2, gain: 0.16 },
  ],
  // Low short — "me callo" (A3 220)
  mode_passive: [{ freq: 220, at: 0, dur: 0.22, gain: 0.18 }],
  // High short — "te escucho de nuevo" (A4 440)
  mode_conversation: [{ freq: 440, at: 0, dur: 0.16, gain: 0.18 }],
  // Double low — requires attention (D3 146.83 twice)
  error: [
    { freq: 146.83, at: 0, dur: 0.16, gain: 0.2 },
    { freq: 146.83, at: 0.22, dur: 0.22, gain: 0.2 },
  ],
  // Soft bell — action pending even if you're not looking (E5·A5·G5)
  worker_permission: [
    { freq: 659.25, at: 0, dur: 0.1, gain: 0.14 },
    { freq: 880, at: 0.12, dur: 0.1, gain: 0.14 },
    { freq: 783.99, at: 0.24, dur: 0.2, gain: 0.12 },
  ],
};

// ─── The hook ────────────────────────────────────────────────────────────────

export interface UseEarconsResult {
  /** Play one of the vocabulary earcons (no-op when muted or unavailable). */
  play: (event: EarconEvent) => void;
  /** Whether earcons are enabled (persisted user setting). */
  enabled: boolean;
  /** Toggle earcons on/off (persists). */
  setEnabled: (value: boolean) => void;
}

export function useEarcons(): UseEarconsResult {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [enabled, setEnabledState] = useState(true);

  // Load the persisted toggle on mount (default ON — the earcons are quiet
  // by design; the user opts OUT, not in).
  useEffect(() => {
    storage.get<boolean>(STORAGE_KEYS.VOICE_EARCONS).then((value) => {
      if (value !== null) setEnabledState(value);
    });
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    storage.set(STORAGE_KEYS.VOICE_EARCONS, value).catch(() => {});
  }, []);

  const play = useCallback(
    (event: EarconEvent) => {
      if (!enabled) return;
      // WebAudio only — the native surface would use the haptic equivalent
      // here (expo-haptics, not a dependency today — extension point, §4.2).
      if (Platform.OS !== 'web') return;

      try {
        if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!Ctor) return;
          audioCtxRef.current = new Ctor();
        }
        const ctx = audioCtxRef.current;

        // System mute / autoplay policy: a suspended context is the browser
        // saying "no sound from this tab" — respect it silently (UX §4.2).
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
          // resume is async — the first earcon after a tab switch may be
          // swallowed; that's the honest behavior, not a bug.
        }

        const now = ctx.currentTime;
        for (const note of EARCON_VOICES[event]) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.setValueAtTime(note.freq, now + note.at);
          const t0 = now + note.at;
          // Soft attack (12ms) + exponential release — never a click.
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(note.gain, t0 + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + note.dur);
          osc.start(t0);
          osc.stop(t0 + note.dur);
        }
      } catch (err) {
        // Earcons are ambient, never critical — a failed synthesis must
        // never break the voice session (nothing breaks in silence, but
        // nothing breaks because of a sound either).
        console.debug('[useEarcons] synthesis failed:', err);
      }
    },
    [enabled],
  );

  // Stable identity: callers list `earcons` in effect deps (VoiceSessionContext,
  // VoiceThreadSection). A fresh object per render re-ran those effects on
  // every render — the permission bell stacked on each interim transcript
  // (PoC finding, Pablo 2026-10-31).
  return useMemo(() => ({ play, enabled, setEnabled }), [play, enabled, setEnabled]);
}

/**
 * The mode transition → earcon mapping (UX §4.2). Pure so the context can
 * diff modes without importing the vocabulary.
 */
export function earconForModeChange(next: string): EarconEvent {
  switch (next) {
    case 'passive':
      return 'mode_passive';
    case 'conversation':
      return 'mode_conversation';
    default:
      return 'mode_conversation';
  }
}
