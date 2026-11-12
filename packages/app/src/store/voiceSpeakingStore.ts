/**
 * voiceSpeakingStore — which assistant message the voice is SOUNDING right
 * now, and how far into its text the playback is (PoC, 2026-10-31).
 *
 * Fed by VoiceSessionContext (speaking_started carries the messageId; a
 * timer reads the TTS player's playback clock against the ElevenLabs
 * character alignment). Read by the agent bubble of that one message to
 * paint the spoken prefix normal and the unspoken tail muted. Other bubbles
 * subscribe with a selector that returns null → they never re-render.
 */
import { create } from 'zustand'

interface VoiceSpeakingState {
  messageId: string | null
  /** Characters of the message text already heard (alignment-based). */
  charIndex: number
  /** Characters the TTS has covered so far (alignment known up to here). */
  alignedChars: number
  start: (messageId: string | null) => void
  tick: (charIndex: number, alignedChars: number) => void
  stop: () => void
}

export const useVoiceSpeakingStore = create<VoiceSpeakingState>((set) => ({
  messageId: null,
  charIndex: 0,
  alignedChars: 0,
  start: (messageId) => set({ messageId, charIndex: 0, alignedChars: 0 }),
  tick: (charIndex, alignedChars) =>
    set((s) => (s.charIndex === charIndex && s.alignedChars === alignedChars ? s : { charIndex, alignedChars })),
  stop: () => set({ messageId: null, charIndex: 0, alignedChars: 0 }),
}))
