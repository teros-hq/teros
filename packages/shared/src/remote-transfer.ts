/**
 * Teros Remote — transfer plane payloads (spec § Transfer Plane v0.7.0, REQ-14).
 *
 * Dedicated tunnel messages that move file bytes between the workspace volume
 * and a paired machine WITHOUT transiting tool results or the agent context.
 *
 * CONTRACT PARITY: mirrors `packages/protocol/src/transfer.ts` in the
 * teros-remote repository field-for-field. Change both sides together.
 *
 * Chunks ride inside the JSON envelope as base64 (`bytes`): the tunnel is a
 * JSON-text channel end to end (both parsers are JSON), so a raw binary frame
 * would bypass envelope correlation. Overhead ~33% — accepted for v0.7.0.
 */

import { z } from 'zod';

/** ~512 KB per chunk (spec). Encoded base64 this is ~700 KB of JSON per frame. */
export const TRANSFER_CHUNK_SIZE = 512 * 1024;

/** Max chunks in flight before the sender waits for an ack (flow-control window). */
export const TRANSFER_WINDOW = 8;

/** Inactivity budget: no data/ack for this long → the transfer aborts with TIMEOUT. */
export const TRANSFER_IDLE_TIMEOUT_MS = 60_000;

/** Base64 of TRANSFER_CHUNK_SIZE bytes is 4/3 — plus a small margin. */
const MAX_CHUNK_B64_CHARS = Math.ceil(TRANSFER_CHUNK_SIZE / 3) * 4 + 8;

export const TransferDirectionSchema = z.enum([
  'pull', // machine → workspace volume (the daemon SENDS bytes)
  'push', // workspace volume → machine (the daemon RECEIVES bytes)
]);
export type TransferDirection = z.infer<typeof TransferDirectionSchema>;

export const TransferModeSchema = z.enum(['create', 'overwrite', 'resume']);
export type TransferMode = z.infer<typeof TransferModeSchema>;

/** either → either: open a transfer. The opener is the side that got the tool_call. */
export const TransferOpenPayloadSchema = z.object({
  /** UUID chosen by the opener — correlates the four transfer message types. */
  transferId: z.string().min(1),
  /** From the WORKSPACE's point of view (pull = machine→volume). */
  direction: TransferDirectionSchema,
  /** Path on the DAEMON side (allowlist-checked there). */
  path: z.string().min(1),
  /** Total bytes when known up-front; -1 when unknown. */
  size: z.number().int(),
  /** Full-file hash when known up-front (push: the backend knows it). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  mode: TransferModeSchema,
  /** Resume token from a previous interrupted transfer of the same file (mode 'resume'). */
  resumeToken: z.string().optional(),
  /** Byte offset the opener already has and wants to continue from (mode 'resume'). */
  offset: z.number().int().nonnegative().optional(),
  /**
   * Workspace-volume path for THIS file (v0.8.0, directory transfers). When
   * set, the backend reads (push) / writes (pull) this exact volume path
   * instead of deriving one from `path`. Never trusted blindly — the backend
   * re-validates it against the workspace volume root.
   */
  volumePath: z.string().optional(),
});
export type TransferOpenPayload = z.infer<typeof TransferOpenPayloadSchema>;

export const TransferOpenErrorSchema = z.object({
  code: z.enum(['FORBIDDEN', 'NOT_FOUND', 'QUOTA_EXCEEDED', 'CONFLICT', 'INVALID_ARGUMENTS', 'INTERNAL_ERROR']),
  message: z.string(),
  hint: z.string().optional(),
});

/** receiver → opener: accept (with the offset to start from) or refuse (error). */
export const TransferOpenAckPayloadSchema = z.object({
  transferId: z.string().min(1),
  accepted: z.boolean(),
  /** Offset the sender MUST start from — the receiver's durable acked position. */
  offset: z.number().int().nonnegative(),
  /** Receiver-side resume token to quote on a later resume. */
  resumeToken: z.string().optional(),
  error: TransferOpenErrorSchema.optional(),
});
export type TransferOpenAckPayload = z.infer<typeof TransferOpenAckPayloadSchema>;

/** sender → receiver: one chunk. `seq` is monotonic per transfer (from 0). */
export const TransferDataPayloadSchema = z.object({
  transferId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  /** Absolute byte offset of this chunk in the file. */
  offset: z.number().int().nonnegative(),
  /** base64, ≤ TRANSFER_CHUNK_SIZE decoded. */
  bytes: z.string().max(MAX_CHUNK_B64_CHARS),
  /** true on the last chunk (may be empty for a 0-byte tail). */
  final: z.boolean().optional(),
});
export type TransferDataPayload = z.infer<typeof TransferDataPayloadSchema>;

/** receiver → sender: flow-control + durable progress. Sent every WINDOW chunks or on demand. */
export const TransferAckPayloadSchema = z.object({
  transferId: z.string().min(1),
  /** Chunks received since the last ack (sender subtracts from its in-flight count). */
  received: z.number().int().nonnegative(),
  /** Next byte offset the receiver wants — everything below it is durable. */
  nextOffset: z.number().int().nonnegative(),
});
export type TransferAckPayload = z.infer<typeof TransferAckPayloadSchema>;

export const TransferCloseStatusSchema = z.enum(['ok', 'abort']);
export type TransferCloseStatus = z.infer<typeof TransferCloseStatusSchema>;

export const TransferCloseErrorSchema = z.object({
  code: z.enum(['HASH_MISMATCH', 'TIMEOUT', 'CANCELLED', 'FORBIDDEN', 'IO_ERROR', 'INTERNAL_ERROR']),
  message: z.string(),
});

/** either → either: finalize (receiver verifies the full-file sha256) or abort. */
export const TransferClosePayloadSchema = z.object({
  transferId: z.string().min(1),
  status: TransferCloseStatusSchema,
  /** Full-file sha256 — set by the receiver on 'ok' (verified over the written bytes). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Durable bytes at the receiver. */
  bytesTransferred: z.number().int().nonnegative(),
  durationMs: z.number().optional(),
  error: TransferCloseErrorSchema.optional(),
});
export type TransferClosePayload = z.infer<typeof TransferClosePayloadSchema>;

/** Metadata-only tool result for pull-file / push-file (spec: no content, ever). */
export interface TransferToolResult {
  ok: boolean;
  direction: TransferDirection;
  sourcePath: string;
  destinationPath: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  /** true when the transfer continued from a previous offset. */
  resumed?: boolean;
  resumedFromOffset?: number;
}
