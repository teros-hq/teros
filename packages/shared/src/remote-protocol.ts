/**
 * Teros Remote tunnel protocol v1.0
 *
 * Messages exchanged between the backend's RemoteDeviceGateway (`/ws/remote`)
 * and a paired `teros-remote` daemon. The envelope is the MCA envelope
 * (`id`, `type`, `timestamp`, `version` "1.0") — see ./mca-protocol.ts.
 *
 * CONTRACT PARITY: this file mirrors `packages/protocol/src/index.ts` in the
 * teros-remote repository field-for-field (names, optionality, error codes).
 * Change both sides together or the tunnel breaks byte-for-byte.
 *
 * @see docs/specs/remote/teros-remote.md § Protocol (tunnel messages)
 */

import { z } from 'zod';

// ============================================================================
// CONSTANTS
// ============================================================================

export const REMOTE_PROTOCOL_VERSION = '1.0' as const;

/** Catalog id of the MCA whose app instances are routed through the tunnel. */
export const REMOTE_MCA_ID = 'mca.teros.remote' as const;

/** Name of the app-instance user secret that holds the pasted device key (spec REQ-3). */
export const REMOTE_DEVICE_KEY_SECRET = 'TEROS_REMOTE_KEY' as const;

/** Tool output truncation — protocol constraint, applies end-to-end (spec § Constraints). */
export const REMOTE_MAX_TOOL_OUTPUT_CHARS = 40_000;

/** Default per-call budget the gateway waits for a `tool_result` (spec: fail fast, never hang). */
export const REMOTE_DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Heartbeat cadence (spec REQ-4: ~20s). The backend marks the device offline after ~3 misses (NFR-3). */
export const REMOTE_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Keep-alive / inactivity-TTL plane (v1.1.0).
 *
 * Model (Pablo, 2026-10-30): the daemon connects automatically and the backend
 * renews every live tunnel with a `keepalive` at least once a day while the
 * user shows signs of life. If the user does not (no workspace entry, no
 * Teros Remote use) for `REMOTE_INACTIVITY_TTL_MS`, the backend orders a clean
 * `stop` and releases the binding. 72h = the non-aggressive end of Pablo's
 * 48–72h range.
 */
export const REMOTE_KEEPALIVE_INTERVAL_MS = 24 * 3_600_000; // daily

/** User-inactivity TTL before the backend stops the daemon (72h). */
export const REMOTE_INACTIVITY_TTL_MS = 72 * 3_600_000;

/**
 * Daemon-side watchdog: a connected daemon that receives NO `keepalive` from
 * the backend for this long shuts itself down (covers a dead backend, a
 * restarted backend that lost the tunnel record, and orphaned tunnels).
 * 26h > daily cadence + generous slack for backend restarts/deploy windows.
 */
export const REMOTE_KEEPALIVE_DAEMON_TIMEOUT_MS = 26 * 3_600_000;

// ============================================================================
// MESSAGE TYPES
// ============================================================================

export const RemoteMessageTypeSchema = z.enum([
  'hello', // daemon → backend: auth (deviceId + key), capabilities, allowlist, host info
  'hello_ack', // backend → daemon: session established
  'ping', // keepalive (both directions)
  'pong',
  'tool_call', // backend → daemon: execute tool (same payload as MCA protocol)
  'tool_result', // daemon → backend: result (same payload as MCA protocol)
  'cancel', // backend → daemon: cancel in-flight call
  'health_update', // daemon → backend: unsolicited status
  'log', // daemon → backend: unsolicited log line
  'error', // backend → daemon: session-level error (e.g. UNAUTHORIZED on a rejected hello)
  // Transfer plane (v0.7.0, REQ-14) — bytes move on these, never in tool results
  'transfer.open', // either → either: start a transfer (direction, path, size, sha256, mode)
  'transfer.open_ack', // receiver → opener: accept (with start offset) or refuse
  'transfer.data', // sender → receiver: chunk (seq, offset, base64 bytes ~512KB)
  'transfer.ack', // receiver → sender: flow-control window (received, nextOffset)
  'transfer.close', // either → either: finalize (verify sha256) or abort
  // Directory plane (v0.8.0, REQ-14) — metadata-only side channel for
  // directory operations the daemon orchestrates but only the backend can
  // answer (workspace-volume manifest, volume-side delete). Bytes still move
  // exclusively on transfer.* — these carry manifests and acks only.
  'dir.op', // daemon → backend: { op: 'manifest' | 'delete', path, caps? }
  'dir.result', // backend → daemon: correlated answer (same envelope id)
  // Keep-alive / TTL plane (v1.1.0, keep-alive + inactivity TTL) — the backend
  // renews live tunnels with a daily `keepalive` while the user is active, and
  // orders a clean shutdown with `stop` when the inactivity TTL expires. The
  // daemon self-shuts down if no `keepalive` arrives within its own budget
  // (covers a dead backend / orphaned tunnels).
  'keepalive', // backend → daemon: tunnel renewed (carries the TTL budget)
  'stop', // backend → daemon: shut down cleanly, do NOT reconnect
  'stop_ack', // daemon → backend: clean shutdown confirmed (best-effort)
]);

export type RemoteMessageType = z.infer<typeof RemoteMessageTypeSchema>;

// ============================================================================
// ENVELOPE
// ============================================================================

/**
 * Tunnel envelope. `payload` is typed per message type below; the envelope
 * itself is validated structurally (`isRemoteEnvelope`) before dispatch.
 */
export interface RemoteEnvelope<T = unknown> {
  /** UUID — request/response correlation (tool_call ↔ tool_result share it) */
  id: string;
  type: RemoteMessageType;
  /** ISO 8601 */
  timestamp: string;
  version: typeof REMOTE_PROTOCOL_VERSION;
  payload: T;
}

export const RemoteEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: RemoteMessageTypeSchema,
  timestamp: z.string(),
  version: z.literal(REMOTE_PROTOCOL_VERSION),
  payload: z.unknown(),
});

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Tunnel error codes. Superset of the MCA codes the gateway surfaces to the
 * executor; the daemon only ever emits the ones marked daemon-side.
 */
export const RemoteErrorCode = {
  /** Device not connected — retryable, surfaced with user guidance (spec REQ-9) */
  MACHINE_UNREACHABLE: 'MACHINE_UNREACHABLE',
  /** Key rejected / revoked */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Path outside allowedRoots (hint lists the roots) — daemon-side */
  FORBIDDEN: 'FORBIDDEN',
  TIMEOUT: 'TIMEOUT',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  /** exec.enabled=false and a bash call arrived — daemon-side */
  EXEC_DISABLED: 'EXEC_DISABLED',
  /** Backend sent `cancel` for an in-flight call */
  CANCELLED: 'CANCELLED',
  /** In-flight cap reached and the queue overflowed — daemon-side */
  BUSY: 'BUSY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** Transfer plane (v0.7.0): file not found on the sending side */
  NOT_FOUND: 'NOT_FOUND',
  /** Transfer plane: workspace quota would be exceeded by the incoming file */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** Transfer plane: conflicting operation (e.g. transfer already in flight) */
  CONFLICT: 'CONFLICT',
  /** Transfer plane: end-to-end sha256 verification failed */
  HASH_MISMATCH: 'HASH_MISMATCH',
  /** Transfer plane: local filesystem error on either side */
  IO_ERROR: 'IO_ERROR',
} as const;

export type RemoteErrorCode = (typeof RemoteErrorCode)[keyof typeof RemoteErrorCode];

export const RemoteErrorCodeSchema = z.enum([
  'MACHINE_UNREACHABLE',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'TIMEOUT',
  'TOOL_NOT_FOUND',
  'INVALID_ARGUMENTS',
  'EXEC_DISABLED',
  'CANCELLED',
  'BUSY',
  'INTERNAL_ERROR',
  'NOT_FOUND',
  'QUOTA_EXCEEDED',
  'CONFLICT',
  'HASH_MISMATCH',
  'IO_ERROR',
]);

export const RemoteErrorSchema = z.object({
  code: RemoteErrorCodeSchema,
  message: z.string(),
  hint: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

export type RemoteError = z.infer<typeof RemoteErrorSchema>;

/** Codes the caller may retry without changing the call. */
const RETRYABLE_REMOTE_CODES: readonly RemoteErrorCode[] = [
  'MACHINE_UNREACHABLE',
  'TIMEOUT',
  'BUSY',
];

export function isRetryableRemoteError(code: string): boolean {
  return RETRYABLE_REMOTE_CODES.includes(code as RemoteErrorCode);
}

// ============================================================================
// PAYLOADS
// ============================================================================

/** daemon → backend. The daemon never sends `key` anywhere else. */
export const RemoteHelloPayloadSchema = z.object({
  deviceId: z.string().min(1),
  /** v1: the daemon-generated key (pasted as the app's user API key) */
  key: z.string().min(1),
  hostname: z.string(),
  /** Optional display name for the machine (daemon sends `name || hostname`). */
  name: z.string().optional(),
  os: z.string(),
  arch: z.string(),
  daemonVersion: z.string(),
  /** Informational mirror; the daemon enforces its own config */
  allowedRoots: z.array(z.string()),
  /** Whether the bash tool is exposed at all */
  execEnabled: z.boolean(),
  /** Tool names this daemon will answer (fs group, device-status, bash when enabled) */
  capabilities: z.array(z.string()),
  /** Concurrent tool_call cap the daemon enforces (spec: 4) */
  maxInFlight: z.number().int().positive(),
  protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
});

export type RemoteHelloPayload = z.infer<typeof RemoteHelloPayloadSchema>;

/** backend → daemon */
export interface RemoteHelloAckPayload {
  sessionId?: string;
  /** Backend may confirm/assign the id it will route on */
  deviceId?: string;
  /** ISO 8601 — daemon clock skew is irrelevant (spec § Edge Cases) */
  serverTime?: string;
  /** Backend override for the ~20s ping cadence */
  heartbeatIntervalMs?: number;
  message?: string;
  /** T-REM-5: workspace the paired app instance belongs to (additive — old daemons ignore it) */
  workspaceId?: string;
  /** T-REM-5: display name — the daemon prints "Paired with workspace X" */
  workspaceName?: string;
  /** Multi-workspace: all app bindings this device is paired to (additive — old daemons ignore it) */
  bindings?: Array<{ appId: string; workspaceName?: string }>;
}

export interface RemotePingPayload {
  seq?: number;
  sentAt?: string;
}

/** backend → daemon */
export interface RemoteToolCallPayload {
  /** 'bash' | 'read-file' | 'create-file' | … (contract parity with mca.teros.filesystem/bash) */
  tool: string;
  arguments: Record<string, unknown>;
  /** Optional per-call budget hint from the backend */
  timeoutMs?: number;
}

/** daemon → backend */
export const RemoteToolResultPayloadSchema = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  error: RemoteErrorSchema.optional(),
  /** ms, monotonic (daemon clock) */
  duration: z.number(),
});

export type RemoteToolResultPayload = z.infer<typeof RemoteToolResultPayloadSchema>;

/** backend → daemon */
export interface RemoteCancelPayload {
  /** Envelope id of the in-flight tool_call to cancel */
  id: string;
  reason?: string;
}

/**
 * backend → daemon (v1.1.0): the tunnel is renewed. Carries the inactivity
 * TTL budget so the daemon can log/anticipate its own expiry. Additive — an
 * old daemon that does not know the type ignores it (envelope dispatch is
 * type-string based, never a hard failure).
 */
export interface RemoteKeepalivePayload {
  /** ISO 8601 — backend clock, informational */
  sentAt: string;
  /** Current inactivity TTL budget (ms) the backend enforces for this device. */
  ttlMs: number;
  /** ISO 8601 — last user activity the backend observed for the bound workspaces. */
  lastUserActivityAt?: string;
}

/**
 * backend → daemon (v1.1.0): shut down cleanly and do NOT reconnect — the
 * inactivity TTL expired. The daemon answers `stop_ack` (best-effort, before
 * exiting) and exits with `REMOTE_STOP_EXIT_CODE` so a supervisor (systemd
 * `RestartPreventExitStatus`) does not resurrect it.
 */
export interface RemoteStopPayload {
  /** Why the backend is stopping the daemon. */
  reason: 'ttl_inactive' | 'revoked' | 'operator';
  /** ISO 8601 — when the backend decided to stop it. */
  stoppedAt: string;
  /** Human-readable explanation shown in the daemon log. */
  message?: string;
}

/** daemon → backend (v1.1.0): clean shutdown confirmed (best-effort). */
export interface RemoteStopAckPayload {
  deviceId: string;
  reason: string;
  /** True when the daemon is exiting without reconnecting. */
  exiting: boolean;
}

/**
 * Exit code the daemon uses when stopped by the backend (TTL). Matches the
 * systemd unit's `RestartPreventExitStatus` so the supervisor stays down.
 * 79 = EX_NOTFOUND-adjacent, unused by the daemon otherwise.
 */
export const REMOTE_STOP_EXIT_CODE = 79;

/** daemon → backend */
export const RemoteHealthUpdatePayloadSchema = z.object({
  status: z.enum(['online', 'degraded']),
  uptimeSeconds: z.number(),
  inFlight: z.number(),
  lastError: z.string().nullable(),
});

export type RemoteHealthUpdatePayload = z.infer<typeof RemoteHealthUpdatePayloadSchema>;

/** daemon → backend */
export const RemoteLogPayloadSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
});

export type RemoteLogPayload = z.infer<typeof RemoteLogPayloadSchema>;

// ============================================================================
// TYPED ENVELOPES
// ============================================================================

export type RemoteHelloEnvelope = RemoteEnvelope<RemoteHelloPayload>;
export type RemoteHelloAckEnvelope = RemoteEnvelope<RemoteHelloAckPayload>;
export type RemoteToolCallEnvelope = RemoteEnvelope<RemoteToolCallPayload>;
export type RemoteToolResultEnvelope = RemoteEnvelope<RemoteToolResultPayload>;
export type RemoteCancelEnvelope = RemoteEnvelope<RemoteCancelPayload>;
export type RemoteErrorEnvelope = RemoteEnvelope<RemoteError>;

// ============================================================================
// HELPERS
// ============================================================================

/** Build an envelope with a fresh id (or the given one, for correlated replies) and timestamp. */
export function createRemoteEnvelope<T>(
  type: RemoteMessageType,
  payload: T,
  id?: string,
): RemoteEnvelope<T> {
  return {
    id: id ?? crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    version: REMOTE_PROTOCOL_VERSION,
    payload,
  };
}

/**
 * Structural check for an inbound frame. Mirrors the daemon's
 * `isTunnelEnvelope` (id + type strings, payload present) so both ends accept
 * the same frames; the per-type payload schemas above do the strict part.
 */
export function isRemoteEnvelope(value: unknown): value is RemoteEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.type === 'string' && 'payload' in v;
}

/** Parse a raw frame into a validated envelope, or null when it is not one. */
export function parseRemoteEnvelope(raw: string): RemoteEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = RemoteEnvelopeSchema.safeParse(parsed);
  return result.success ? (result.data as RemoteEnvelope) : null;
}
