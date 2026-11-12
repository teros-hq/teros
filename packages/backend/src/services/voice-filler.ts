/**
 * Voice Filler Phrase — the pre-generated "Mmm." that covers the LLM gap
 *
 * Voice Mode v2 — F5b (perception tuning): when a user turn activates and
 * the first LLM text chunk has not arrived within ~400ms, the voice loop
 * plays this short filler so the user hears SOMETHING instead of dead
 * silence. The filler is:
 *
 *   - PRE-GENERATED: a baked MP3 asset (assets/voice/filler-mmm.mp3) made
 *     ONCE with the agent's default ElevenLabs voice (4v1uoUi065MedHZMinXC —
 *     Azu M, Calm & professional & spanish;
 *     eleven_flash_v2_5, "Mmm.") — NEVER a new synthesis call at runtime.
 *     This is the whole point: a filler that costs an HTTP round-trip
 *     would arrive LATER than the thing it is filling.
 *   - INTERRUPTIBLE: it is delivered as ordinary `tts_chunk` frames
 *     bracketed by `speaking_started`/`speaking_ended`, so the client's
 *     useTtsPlayer plays it through the same FIFO/stop machinery — a
 *     barge-in `interrupt` frame stops it exactly like any TTS.
 *   - LOW VOLUME: the loop frames it with `filler: true` on
 *     `speaking_started` so the client can duck it if it wants (the frame
 *     contract carries the hint; the default player plays it as-is).
 *
 * The asset is read ONCE per process (module-level cache) and sliced into
 * ~3KB base64 frames — the same chunking the TTS providers use, so the
 * client-side framing (ID3 magic detection) treats it as one sentence MP3.
 *
 * Pure logic + one lazy fs read — unit-testable with a fake loader.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Bytes of raw audio per tts_chunk frame (matches the TTS providers' chunking). */
const FILLER_CHUNK_BYTES = 3 * 1024;

/** Module-level cache: the baked MP3, read once per process. */
let cachedFillerBase64: string | null = null;
/** True once a value (real or null) has been cached — null is a VALID cache entry. */
let fillerCacheLoaded = false;

/**
 * Load the baked filler MP3 as base64 (cached). Resolution mirrors
 * email-service's template path handling (ESM + CJS safe). A missing or
 * unreadable asset returns null — the caller treats that as "no filler"
 * and the session proceeds in silence (a missing asset must never break
 * a voice session).
 */
export function loadFillerAudioBase64(): string | null {
  // null is a VALID cached value (asset missing) — the flag distinguishes
  // "not loaded yet" from "loaded and absent". Without it, a missing asset
  // would re-read the fs on EVERY call (and a test-injected null would be
  // overwritten by the real read on the next call).
  if (fillerCacheLoaded) return cachedFillerBase64;
  try {
    let dir: string;
    if (typeof __dirname !== 'undefined') {
      dir = __dirname;
    } else {
      dir = dirname(fileURLToPath(import.meta.url));
    }
    const assetPath = join(dir, '../../assets/voice/filler-mmm.mp3');
    const buf = readFileSync(assetPath);
    cachedFillerBase64 = buf.toString('base64');
    fillerCacheLoaded = true;
    return cachedFillerBase64;
  } catch {
    // Missing asset (or unreadable) — no filler, no crash. The flag stays
    // on but every turn degrades to pre-F5b silence.
    cachedFillerBase64 = null;
    fillerCacheLoaded = true;
    return null;
  }
}

/**
 * Slice the filler audio into tts_chunk payloads (~3KB base64 frames, the
 * providers' chunking). Returns [] when the asset is unavailable. The
 * frames are sent back-to-back — the client accumulates them into one
 * sentence MP3 (the asset starts with the ID3 magic like every
 * ElevenLabs MP3).
 */
export function fillerChunkFrames(): string[] {
  const base64 = loadFillerAudioBase64();
  if (!base64) return [];
  // base64 length ≈ 4/3 × bytes; slice by the encoded length in ~4KB
  // units so each frame decodes to ~3KB of raw audio.
  const frames: string[] = [];
  const encodedChunk = Math.ceil((FILLER_CHUNK_BYTES * 4) / 3);
  for (let i = 0; i < base64.length; i += encodedChunk) {
    frames.push(base64.slice(i, i + encodedChunk));
  }
  return frames;
}

/** Test hook: reset the module-level cache (forces a fresh read). */
export function resetFillerCacheForTests(): void {
  cachedFillerBase64 = null;
  fillerCacheLoaded = false;
}

/** Test hook: inject a fake filler payload (bypasses the fs read). */
export function setFillerForTests(base64: string | null): void {
  cachedFillerBase64 = base64;
  fillerCacheLoaded = true;
}
