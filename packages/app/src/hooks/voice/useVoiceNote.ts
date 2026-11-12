/**
 * useVoiceNote — record a short voice note and turn it into text with the
 * chat's speech-to-text (`channel.transcribe-audio`), docs/specs/todo/autoplay
 * TODOAP-REQ-26. The recorder engine is the chat composer's choice: Safari
 * (and iOS) records with the native MediaRecorder (`audio/mp4`, else
 * `audio/webm`); every other browser records with RecordRTC's
 * StereoAudioRecorder, mono at 16 kHz (`audio/wav` on iOS, else `audio/webm`).
 *
 * The state machine mirrors the chat composer's dictation control
 * (InputComposer.web.tsx): idle → starting (mic spinner while the permission
 * prompt is open) → recording (live waveform + counter) → stopped (audio in
 * hand: playback, discard, or transcribe) → transcribing → idle. The
 * transcript is handed to the CALLER — the composer sends it, the note boxes
 * write it into their field. Stopping NEVER submits anything (Pablo,
 * 2026-10-30): the pencil (`transcribe`) is what turns audio into text, and
 * the field's own send button is the only thing that sends.
 *
 * Web only: on native `start` reports the `unsupported` error.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import {
  assembleBlob,
  blobToBase64,
  calculateMetering,
  MAX_WAVEFORM_SAMPLES,
  normalizeMetering,
} from "../../components/InputComposer.audio"
import { getTerosClient } from "../../services/terosClientSingleton"

export type VoiceNoteState = "idle" | "starting" | "recording" | "stopped" | "transcribing"
export type VoiceNoteErrorCode = "unsupported" | "permission" | "empty" | "transcription"

/** A running recording: `stop` finalises it and hands back the audio. */
export interface VoiceNoteRecorder {
  stop(): Promise<Blob | null>
}

/** The audio a stopped recording holds (the composer's AudioRecording shape). */
export interface VoiceNoteAudio {
  blob: Blob
  duration: number
  url: string
}

function isAppleWebKit() {
  const ua = navigator.userAgent
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua) || isIOS
  return { isIOS, isSafari }
}

/** The chat composer's engine choice (InputComposer.web.tsx `startRecording`). */
async function startComposerRecorder(stream: MediaStream): Promise<VoiceNoteRecorder> {
  const { isIOS, isSafari } = isAppleWebKit()
  if (isSafari && typeof MediaRecorder !== "undefined") {
    const mimeType = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm"
    const chunks: Blob[] = []
    const rec = new MediaRecorder(stream, { mimeType })
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.start(5000)
    return {
      stop: () =>
        new Promise((resolve) => {
          if (rec.state === "inactive") return resolve(assembleBlob(chunks))
          rec.addEventListener("stop", () => resolve(assembleBlob(chunks)), { once: true })
          rec.stop()
        }),
    }
  }
  const { default: RecordRTC, StereoAudioRecorder } = await import("recordrtc")
  const rec = new RecordRTC(stream, {
    type: "audio",
    mimeType: isIOS ? "audio/wav" : "audio/webm",
    recorderType: StereoAudioRecorder,
    numberOfAudioChannels: 1,
    desiredSampRate: 16000,
    disableLogs: true,
  })
  rec.startRecording()
  return {
    stop: () => new Promise((resolve) => rec.stopRecording(() => resolve(rec.getBlob() ?? null))),
  }
}

/** @spec TODOAP-REQ-26 */
export function useVoiceNote({
  onTranscript,
  onError,
}: {
  onTranscript: (text: string) => void
  onError: (message: string, code: VoiceNoteErrorCode) => void
}) {
  const [state, setState] = useState<VoiceNoteState>("idle")
  const [seconds, setSeconds] = useState(0)
  /** Live waveform samples (0..1) — the composer's rolling buffer. */
  const [samples, setSamples] = useState<number[]>([])
  /** The take held between `stop` and transcribe/discard (null otherwise). */
  const [audio, setAudio] = useState<VoiceNoteAudio | null>(null)
  const stateRef = useRef<VoiceNoteState>("idle")
  const secondsRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<VoiceNoteRecorder | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const sampleCountRef = useRef(0)
  const audioRef = useRef<VoiceNoteAudio | null>(null)
  const mountedRef = useRef(true)
  const cbRef = useRef({ onTranscript, onError })
  cbRef.current = { onTranscript, onError }

  const go = (s: VoiceNoteState) => {
    stateRef.current = s
    if (mountedRef.current) setState(s)
  }
  /** Ref read that TS cannot narrow — `go` mutates the ref under async gaps. */
  const phase = () => stateRef.current as VoiceNoteState
  const dropAudio = () => {
    if (audioRef.current?.url) URL.revokeObjectURL(audioRef.current.url)
    audioRef.current = null
    if (mountedRef.current) setAudio(null)
  }
  /** Stop the live viz + timer and tear the stream/context down. */
  const release = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (audioContextRef.current) {
      // Best-effort close: a suspended context can reject — it is teardown of
      // a visualisation aid, not of the recording itself.
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    analyserRef.current = null
  }
  const reset = () => {
    release()
    dropAudio()
    recorderRef.current = null
    go("idle")
    if (mountedRef.current) {
      setSeconds(0)
      secondsRef.current = 0
      setSamples([])
    }
  }
  const fail = (message: string, code: VoiceNoteErrorCode) => {
    reset()
    cbRef.current.onError(message, code)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const rec = recorderRef.current
      recorderRef.current = null
      if (rec) void rec.stop().catch(() => {})
      release()
      dropAudio()
    }
  }, [])

  const start = useCallback(async () => {
    // From `stopped` the composer restarts a fresh take — drop the held one.
    if (stateRef.current === "stopped") {
      dropAudio()
      go("idle")
    }
    if (stateRef.current !== "idle") return
    if (Platform.OS !== "web" || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      cbRef.current.onError("Voice recording is not supported here", "unsupported")
      return
    }
    go("starting")
    secondsRef.current = 0
    sampleCountRef.current = 0
    if (mountedRef.current) {
      setSeconds(0)
      setSamples([])
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), "permission")
      return
    }
    // Unmounted (or reset) while the permission prompt was open.
    if (!mountedRef.current || phase() !== "starting") {
      stream.getTracks().forEach((tr) => tr.stop())
      return
    }
    streamRef.current = stream
    try {
      recorderRef.current = await startComposerRecorder(stream)
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), "unsupported")
      return
    }
    if (!mountedRef.current || phase() !== "starting") {
      stream.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
      return
    }
    // The composer's live waveform: an AnalyserNode feeds a rolling buffer of
    // normalized samples, one append every other frame (the composer's
    // metering-count skip). Best-effort — without it the counter still runs.
    try {
      const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext
      if (AudioContextClass) {
        const ctx = new AudioContextClass()
        audioContextRef.current = ctx
        if (ctx.state === "suspended") await ctx.resume()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.7
        ctx.createMediaStreamSource(stream).connect(analyser)
        analyserRef.current = analyser
        const tick = () => {
          const a = analyserRef.current
          if (!a) return
          const db = calculateMetering(a)
          sampleCountRef.current += 1
          if (sampleCountRef.current % 2 === 0 && mountedRef.current) {
            setSamples((prev) => {
              const next = [...prev, normalizeMetering(db)]
              return next.length > MAX_WAVEFORM_SAMPLES ? next.slice(next.length - MAX_WAVEFORM_SAMPLES) : next
            })
          }
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      }
    } catch {
      // No visualisation — the recording itself is unaffected.
    }
    go("recording")
    timerRef.current = setInterval(() => {
      secondsRef.current += 1
      if (mountedRef.current) setSeconds(secondsRef.current)
    }, 1000)
  }, [])

  /** Finalise the take: audio in hand (playback URL), waiting for the caller. */
  const stop = useCallback(async (): Promise<VoiceNoteAudio | null> => {
    const rec = recorderRef.current
    if (stateRef.current !== "recording" || !rec) return null
    recorderRef.current = null
    // Freeze the counter and the live viz — the take is being finalised.
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    analyserRef.current = null
    go("stopped")
    let blob: Blob | null = null
    try {
      blob = await rec.stop()
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), "transcription")
      return null
    }
    // Teardown AFTER the recorder finalised — stopping the tracks first can
    // starve RecordRTC's tail (the composer stops recorder, then tracks).
    streamRef.current?.getTracks().forEach((tr) => tr.stop())
    streamRef.current = null
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    if (!blob || blob.size === 0) {
      fail("The recording is empty", "empty")
      return null
    }
    const take: VoiceNoteAudio = { blob, duration: secondsRef.current, url: URL.createObjectURL(blob) }
    audioRef.current = take
    if (mountedRef.current) setAudio(take)
    return take
  }, [])

  /** Drop the take and go back to idle — the field keeps whatever it had. */
  const discard = useCallback(() => {
    reset()
  }, [])

  /**
   * The composer's pencil: transcribe the take and hand the text back —
   * NEVER submits. While still recording it stops first (the composer's
   * `handleTranscribe`), so the pencil is also the "stop and write" button.
   */
  const transcribe = useCallback(async (): Promise<string | null> => {
    if (stateRef.current === "recording") {
      const take = await stop()
      if (!take) return null
    }
    const take = audioRef.current
    if (stateRef.current !== "stopped" || !take) return null
    go("transcribing")
    let text = ""
    try {
      const data = await blobToBase64(take.blob)
      const res = await getTerosClient().channel.transcribeAudio(data, take.blob.type || "audio/webm")
      text = res.text?.trim() ?? ""
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), "transcription")
      return null
    }
    if (!text) {
      fail("The transcription is empty", "empty")
      return null
    }
    // A discard while the request was in flight wins — no text lands.
    if (phase() !== "transcribing") return null
    release()
    dropAudio()
    recorderRef.current = null
    go("idle")
    if (mountedRef.current) {
      setSeconds(0)
      secondsRef.current = 0
      setSamples([])
    }
    cbRef.current.onTranscript(text)
    return text
  }, [stop])

  return { state, seconds, samples, audio, start, stop, discard, transcribe }
}
