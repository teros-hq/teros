/**
 * usePermissionSound
 *
 * Plays a notification sound when a tool permission request arrives.
 * Uses the Web Audio API to generate a synthetic alert tone — no external
 * audio files required.
 *
 * The sound is a two-tone "ding-dong" that is distinct and non-intrusive.
 */

import { useCallback, useRef } from "react"
import { Platform } from "react-native"

export function usePermissionSound() {
  // Keep a reference to the AudioContext so we reuse it across calls
  const audioCtxRef = useRef<AudioContext | null>(null)

  const playPermissionSound = useCallback(() => {
    // Only available on web
    if (Platform.OS !== "web") return

    try {
      // Lazily create the AudioContext (browsers require user gesture first,
      // but by the time a permission request arrives the user has already
      // interacted with the page, so this is fine).
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext()
      }

      const ctx = audioCtxRef.current

      // Resume if suspended (e.g. after tab switch)
      if (ctx.state === "suspended") {
        ctx.resume()
      }

      const now = ctx.currentTime

      // Durations: semicorchea = 0.1s, corchea = 0.2s (at ~120bpm feel)
      const semi = 0.1   // RE, MI
      const corch = 0.22 // DO

      const attack = 0.012
      const noteGap = 0.02 // small silence between notes

      // --- RE5 (587.33 Hz) — semicorchea ---
      const t0 = now
      const osc1 = ctx.createOscillator()
      const gain1 = ctx.createGain()
      osc1.connect(gain1)
      gain1.connect(ctx.destination)
      osc1.type = "sine"
      osc1.frequency.setValueAtTime(587.33, t0)
      gain1.gain.setValueAtTime(0, t0)
      gain1.gain.linearRampToValueAtTime(0.32, t0 + attack)
      gain1.gain.exponentialRampToValueAtTime(0.001, t0 + semi)
      osc1.start(t0)
      osc1.stop(t0 + semi)

      // --- MI5 (659.25 Hz) — semicorchea ---
      const t1 = t0 + semi + noteGap
      const osc2 = ctx.createOscillator()
      const gain2 = ctx.createGain()
      osc2.connect(gain2)
      gain2.connect(ctx.destination)
      osc2.type = "sine"
      osc2.frequency.setValueAtTime(659.25, t1)
      gain2.gain.setValueAtTime(0, t1)
      gain2.gain.linearRampToValueAtTime(0.32, t1 + attack)
      gain2.gain.exponentialRampToValueAtTime(0.001, t1 + semi)
      osc2.start(t1)
      osc2.stop(t1 + semi)

      // --- DO5 (523.25 Hz) — corchea ---
      const t2 = t1 + semi + noteGap
      const osc3 = ctx.createOscillator()
      const gain3 = ctx.createGain()
      osc3.connect(gain3)
      gain3.connect(ctx.destination)
      osc3.type = "sine"
      osc3.frequency.setValueAtTime(523.25, t2)
      gain3.gain.setValueAtTime(0, t2)
      gain3.gain.linearRampToValueAtTime(0.32, t2 + attack)
      gain3.gain.exponentialRampToValueAtTime(0.001, t2 + corch)
      osc3.start(t2)
      osc3.stop(t2 + corch)
    } catch (err) {
      // Silently ignore — audio is a nice-to-have, not critical
      console.warn("[usePermissionSound] Could not play sound:", err)
    }
  }, [])

  return { playPermissionSound }
}
