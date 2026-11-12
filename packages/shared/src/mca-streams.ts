/**
 * MCA streams — wire types (spec docs/specs/20261104_mca-streams.md, MCS).
 *
 * A stream is a named, scoped channel an MCA pushes binary frames and JSON
 * state into, and receives viewers' input from. Control frames ride on the
 * MCA's `/mca` socket as JSON (these schemas join the MCA ↔ backend unions in
 * mca-health.ts); frames are binary messages on the same socket; people
 * watch on `/ws/stream` (the viewer protocol, also here).
 */

import { z } from "zod"

// ── Limits (MCS-NFR-1) ───────────────────────────────────────────────────────

export const STREAM_ID_MAX_LEN = 200
export const STREAM_KIND_MAX_LEN = 40
/** Streams one app may hold open. */
export const STREAMS_PER_APP_MAX = 256
/** A binary frame larger than this is dropped by the relay. */
export const STREAM_FRAME_MAX_BYTES = 2 * 1024 * 1024
/** A viewer with more than this buffered skips frames until it drains. */
export const STREAM_VIEWER_BUFFER_CAP = 1024 * 1024
/** The SDK drops frames when the MCA's socket has more than this buffered. */
export const STREAM_SDK_BUFFER_CAP = 4 * 1024 * 1024
/** Viewer ticket lifetime. */
export const STREAM_TICKET_TTL_MS = 60_000
/** Binary frame layout version byte. */
export const STREAM_FRAME_VERSION = 1

// ── Scope ────────────────────────────────────────────────────────────────────

/** Who may watch: one user, inside one workspace (MCS-REQ-8). */
export const StreamScopeSchema = z.object({
  userId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(200),
})
export type StreamScope = z.infer<typeof StreamScopeSchema>

const streamId = z.string().min(1).max(STREAM_ID_MAX_LEN)
const streamKind = z.string().min(1).max(STREAM_KIND_MAX_LEN)
const jsonObject = z.record(z.unknown())

// ── MCA → backend (MCS-REQ-2) ────────────────────────────────────────────────

export const WsStreamOpenSchema = z.object({
  type: z.literal("stream_open"),
  streamId,
  kind: streamKind,
  scope: StreamScopeSchema,
  state: jsonObject.optional(),
  meta: jsonObject.optional(),
})
export type WsStreamOpen = z.infer<typeof WsStreamOpenSchema>

export const WsStreamStateSchema = z.object({
  type: z.literal("stream_state"),
  streamId,
  state: jsonObject,
})
export type WsStreamState = z.infer<typeof WsStreamStateSchema>

export const WsStreamCloseSchema = z.object({
  type: z.literal("stream_close"),
  streamId,
  reason: z.string().max(200).optional(),
})
export type WsStreamClose = z.infer<typeof WsStreamCloseSchema>

// ── backend → MCA (MCS-REQ-4) ────────────────────────────────────────────────

export const StreamViewerSchema = z.object({
  viewerId: z.string(),
  userId: z.string(),
  meta: jsonObject.optional(),
})
export type StreamViewer = z.infer<typeof StreamViewerSchema>

export const WsStreamViewersSchema = z.object({
  type: z.literal("stream_viewers"),
  streamId,
  viewers: z.array(StreamViewerSchema),
})
export type WsStreamViewers = z.infer<typeof WsStreamViewersSchema>

export const WsStreamInputSchema = z.object({
  type: z.literal("stream_input"),
  streamId,
  viewerId: z.string(),
  userId: z.string(),
  input: jsonObject,
})
export type WsStreamInput = z.infer<typeof WsStreamInputSchema>

export const WsStreamErrorSchema = z.object({
  type: z.literal("stream_error"),
  streamId,
  code: z.string(),
  message: z.string().optional(),
})
export type WsStreamError = z.infer<typeof WsStreamErrorSchema>

// ── Binary frames (MCS-REQ-3) ────────────────────────────────────────────────

/**
 * MCA → backend: `[u8 version=1][u8 kind][u8 idLen][streamId utf8][payload]`.
 * `kind` is the stream's own vocabulary (a browser tab uses 1 = JPEG frame).
 */
export function encodeStreamFrame(id: string, kind: number, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id)
  if (idBytes.length > 255) throw new Error("stream id too long for a frame header")
  const out = new Uint8Array(3 + idBytes.length + payload.length)
  out[0] = STREAM_FRAME_VERSION
  out[1] = kind & 0xff
  out[2] = idBytes.length
  out.set(idBytes, 3)
  out.set(payload, 3 + idBytes.length)
  return out
}

export interface StreamFrame {
  id: string
  kind: number
  payload: Uint8Array
}

/** Decode an MCA → backend frame; null when malformed or of another version. */
export function decodeStreamFrame(buf: Uint8Array): StreamFrame | null {
  if (buf.length < 3 || buf[0] !== STREAM_FRAME_VERSION) return null
  const idLen = buf[2]
  if (buf.length < 3 + idLen) return null
  return {
    id: new TextDecoder().decode(buf.subarray(3, 3 + idLen)),
    kind: buf[1],
    payload: buf.subarray(3 + idLen),
  }
}

/**
 * Relay → viewer: `[u8 kind][u8 idLen][streamId utf8][payload]` (the terminal
 * data plane's layout, so one decoder serves both).
 */
export function encodeViewerFrame(id: string, kind: number, payload: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id)
  const out = new Uint8Array(2 + idBytes.length + payload.length)
  out[0] = kind & 0xff
  out[1] = idBytes.length
  out.set(idBytes, 2)
  out.set(payload, 2 + idBytes.length)
  return out
}

export function decodeViewerFrame(buf: Uint8Array): StreamFrame | null {
  if (buf.length < 2) return null
  const idLen = buf[1]
  if (buf.length < 2 + idLen) return null
  return {
    kind: buf[0],
    id: new TextDecoder().decode(buf.subarray(2, 2 + idLen)),
    payload: buf.subarray(2 + idLen),
  }
}

// ── Viewer protocol on /ws/stream (MCS-REQ-8) ────────────────────────────────

/** Client → relay. */
export type StreamViewerMessage =
  | { t: "attach"; id: string; meta?: Record<string, unknown> }
  | { t: "detach"; id: string }
  | ({ t: "in"; id: string } & Record<string, unknown>)
  | { t: "ping"; c: number }

/** Relay → client (plus binary viewer frames). */
export type StreamRelayMessage =
  | {
      t: "attached"
      id: string
      kind: string
      state: Record<string, unknown>
      meta: Record<string, unknown>
    }
  | { t: "state"; id: string; state: Record<string, unknown> }
  | { t: "closed"; id: string; reason: string }
  | { t: "err"; id?: string; code: string; msg?: string }
  | { t: "pong"; c: number; s: number }

/** Error codes the relay answers on attach. */
export const STREAM_ERROR_CODES = [
  "STREAM_NOT_FOUND",
  "FORBIDDEN_STREAM",
  "FORBIDDEN_WORKSPACE_ROLE",
  "STREAMS_NOT_DECLARED",
  "STREAM_LIMIT",
  "BAD_ATTACH",
] as const
export type StreamErrorCode = (typeof STREAM_ERROR_CODES)[number]
