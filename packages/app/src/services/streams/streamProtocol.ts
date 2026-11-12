/**
 * /ws/stream frames as the SPA speaks them (spec docs/specs/20261104_mca-streams.md,
 * MCS-REQ-8). Pure helpers, no React. Binary viewer frames share the
 * terminal data plane's layout: `[kind u8][idLen u8][id utf8][payload]`.
 */

export interface ViewerFrame {
  kind: number
  id: string
  payload: Uint8Array
}

export function decodeViewerFrame(buf: ArrayBuffer): ViewerFrame | null {
  const bytes = new Uint8Array(buf)
  if (bytes.length < 2) return null
  const idLen = bytes[1]
  if (bytes.length < 2 + idLen) return null
  return {
    kind: bytes[0],
    id: new TextDecoder().decode(bytes.subarray(2, 2 + idLen)),
    payload: bytes.subarray(2 + idLen),
  }
}

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

export interface TicketResponse {
  ticket: string
  path: string
}
