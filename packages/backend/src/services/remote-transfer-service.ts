/**
 * RemoteTransferService — the backend end of the transfer plane
 * (docs/specs/remote/teros-remote.md § Transfer Plane v0.7.0, REQ-14;
 * acceptance AC-12/13/15).
 *
 * Bridges a `pull-file` / `push-file` tool call to the dedicated transfer
 * messages on the device tunnel. Bytes NEVER transit a tool result or the
 * agent context — the result is metadata only (bytes, sha256, durationMs,
 * destination path).
 *
 * Roles (the daemon always sends `transfer.open` because it got the tool_call;
 * this service answers the open and then plays the byte-side role):
 *  - pull-file: the DAEMON sends bytes → we are the RECEIVER. Chunks are
 *    written at their absolute offset into the workspace volume (hostPath),
 *    acked in windows, sha256-verified on close. The workspace quota is
 *    enforced up-front (declared size) and per-chunk (actual bytes).
 *  - push-file: WE send bytes → we are the SENDER. The volume file is read in
 *    chunks with a sliding ack window, sha256 streamed, and the daemon
 *    verifies the full file before answering ok.
 *
 * Resume (AC-15): the receiver persists `{ resumeToken, offset, size, sha256,
 * path }` under `<volumeHostPath>/.teros/transfers/` on every ack — durable
 * across backend restarts and tunnel drops. A retried call with
 * `mode: 'resume'` + the token continues from the durable offset.
 *
 * One active transfer per device+direction in v1 (the gateway caps in-flight
 * tool calls anyway); a concurrent attempt fails BUSY.
 */

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import {
  createRemoteEnvelope,
  TRANSFER_CHUNK_SIZE,
  TRANSFER_IDLE_TIMEOUT_MS,
  TRANSFER_WINDOW,
  TransferAckPayloadSchema,
  TransferClosePayloadSchema,
  TransferDataPayloadSchema,
  TransferOpenPayloadSchema,
  type RemoteEnvelope,
  type RemoteErrorCode,
  type RemoteToolResultPayload,
  type TransferAckPayload,
  type TransferClosePayload,
  type TransferDataPayload,
  type TransferOpenAckPayload,
  type TransferOpenPayload,
  type TransferToolResult,
} from '@teros/shared';
import { createLogger } from '../lib/logger';
import type { VolumeService } from './volume-service';
import type { WorkspaceService } from './workspace-service';
import type { RemoteDeviceGateway } from './remote-device-gateway';

const log = createLogger('RemoteTransferService');

/** Workspace-side resume state lives in the volume itself (durable + quota-accounted). */
const RESUME_DIR = '.teros/transfers';

interface ResumeState {
  resumeToken: string;
  transferId: string;
  /** Volume-relative destination path (no /workspace prefix). */
  relPath: string;
  direction: 'pull' | 'push';
  /** Durable bytes at the receiver — the offset the next resume starts from. */
  offset: number;
  size: number;
  sha256?: string;
  updatedAt: string;
}

interface PendingOp {
  key: string; // `${appId}:${direction}`
  appId: string;
  deviceId?: string;
  direction: 'pull' | 'push';
  /**
   * v0.8.0 (directory transfers): the workspace whose volume this op reads
   * from / writes to. Set for every op; used to resolve `volumePath` when the
   * daemon orchestrates a directory transfer (one open per file).
   */
  workspaceId?: string;
  /**
   * v0.8.0: true when this op was created ad-hoc by a directory-mode
   * transfer.open (volumePath present, no prior tool_call). Ad-hoc ops are
   * per-file and are torn down when that file's transfer closes.
   */
  adhoc?: boolean;
  /** Resolves when the daemon's tool_result arrives (after the transfer closes). */
  resolve: (r: TransferToolResult | { error: { code: RemoteErrorCode; message: string; hint?: string } }) => void;
  reject: (e: Error) => void;
  startedAt: number;
  /** Receiver state (pull) */
  recv?: {
    transferId: string;
    fd: number;
    offset: number;
    sinceAck: number;
    hash: ReturnType<typeof createHash>;
    size: number;
    expectedSha256?: string;
    resumeToken: string;
    absPath: string;
    relPath: string;
    idleTimer: ReturnType<typeof setTimeout>;
  };
  /** Sender state (push) */
  send?: {
    transferId: string;
    offset: number;
    seq: number;
    inFlight: number;
    ackedOffset: number;
    size: number;
    hash: ReturnType<typeof createHash>;
    absPath: string;
    eof: boolean;
    idleTimer: ReturnType<typeof setTimeout>;
    /** set when the final close-ok from the receiver arrives */
    onClosed?: (close: TransferClosePayload) => void;
    /** true once the close frame has been sent — a late ack must NOT re-enter
     *  the close path (the hash is finalized there; a second digest() crashes
     *  with ERR_CRYPTO_HASH_FINALIZED). */
    closeSent?: boolean;
    /** Captured at close-send; the hash cannot be re-digested afterwards. */
    finalHash?: string;
    /** Re-entrancy guard: onAck fires pump() while a previous pump may still
     *  be awaiting a read — without this, two pumps interleave and double-send. */
    pumping?: boolean;
    /** set when an ack arrived while pumping — pump loops once more at the end. */
    pumpAgain?: boolean;
  };
}

export interface RemoteTransferServiceOptions {
  gateway: RemoteDeviceGateway;
  volumeService: VolumeService;
  workspaceService: WorkspaceService;
  chunkSize?: number;
  window?: number;
  idleTimeoutMs?: number;
}

export class RemoteTransferService {
  private readonly gateway: RemoteDeviceGateway;
  private readonly volumeService: VolumeService;
  private readonly workspaceService: WorkspaceService;
  private readonly chunkSize: number;
  private readonly window: number;
  private readonly idleTimeoutMs: number;
  private readonly pending = new Map<string, PendingOp>();

  constructor(opts: RemoteTransferServiceOptions) {
    this.gateway = opts.gateway;
    this.volumeService = opts.volumeService;
    this.workspaceService = opts.workspaceService;
    this.chunkSize = opts.chunkSize ?? TRANSFER_CHUNK_SIZE;
    this.window = opts.window ?? TRANSFER_WINDOW;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? TRANSFER_IDLE_TIMEOUT_MS;
  }

  // ==========================================================================
  // VOLUME HELPERS
  // ==========================================================================

  /** Resolve a `/workspace/...` path to a safe absolute path under the volume's hostPath. */
  private async resolveVolumePath(
    workspaceId: string,
    workspacePath: string,
  ): Promise<{ absPath: string; relPath: string; hostPath: string; quota: number }> {
    const workspace = await this.workspaceService.getWorkspace(workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const volume = await this.volumeService.getVolume(workspace.volumeId);
    if (!volume) throw new Error(`Volume not found for workspace ${workspaceId}`);
    const hostPath = resolve(volume.hostPath);

    // Strip the canonical /workspace prefix; reject escapes.
    let rel = workspacePath.replace(/^\/workspace\/?/, '');
    if (!rel) throw new Error(`Invalid destination path: ${workspacePath}`);
    const absPath = resolve(hostPath, rel);
    if (absPath !== hostPath && !absPath.startsWith(hostPath + sep)) {
      throw new Error(`Path escapes the workspace volume: ${workspacePath}`);
    }
    return { absPath, relPath: rel, hostPath, quota: volume.quota ?? 0 };
  }

  /** Current volume usage in bytes (best-effort recursive walk). */
  private async volumeUsageBytes(hostPath: string): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        try {
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) total += (await stat(p)).size;
        } catch {
          // unreadable — skip
        }
      }
    };
    await walk(hostPath);
    return total;
  }

  /** Enforce the workspace quota (0 = unlimited). `additional` = bytes about to be added. */
  private async checkQuota(hostPath: string, quota: number, additional: number): Promise<void> {
    if (!quota || quota <= 0) return;
    const used = await this.volumeUsageBytes(hostPath);
    if (used + additional > quota) {
      throw Object.assign(
        new Error(
          `Workspace quota exceeded: ${used} + ${additional} bytes > ${quota} byte limit. Free space or ask for a larger quota.`,
        ),
        { code: 'QUOTA_EXCEEDED' },
      );
    }
  }

  // ==========================================================================
  // RESUME STATE (receiver side, persisted in the volume)
  // ==========================================================================

  private resumeFilePath(hostPath: string, token: string): string {
    return join(hostPath, RESUME_DIR, `${token}.json`);
  }

  private async loadResume(hostPath: string, token: string): Promise<ResumeState | null> {
    try {
      const raw = JSON.parse(await readFile(this.resumeFilePath(hostPath, token), 'utf8'));
      return raw?.resumeToken === token ? (raw as ResumeState) : null;
    } catch {
      return null;
    }
  }

  /**
   * Resume-state mutations are serialized per token through a promise chain:
   * a late save from an aborted attempt must never land AFTER the final drop
   * of a successful resume (that would resurrect a stale token).
   */
  private readonly resumeQueues = new Map<string, Promise<void>>();

  private enqueueResumeOp(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.resumeQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run even if the previous op failed
    this.resumeQueues.set(key, next);
    void next.finally(() => {
      if (this.resumeQueues.get(key) === next) this.resumeQueues.delete(key);
    });
    return next;
  }

  private saveResume(hostPath: string, state: ResumeState): Promise<void> {
    return this.enqueueResumeOp(this.resumeFilePath(hostPath, state.resumeToken), async () => {
      // Best-effort persistence: a failed save must never break the transfer
      // itself (worst case, a resume restarts from an older offset).
      try {
        const p = this.resumeFilePath(hostPath, state.resumeToken);
        mkdirSync(dirname(p), { recursive: true });
        // Unique tmp per call — concurrent acks would otherwise rename the same
        // tmp file and crash with ENOENT.
        const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
        await rename(tmp, p);
      } catch (err) {
        log.warn({ err }, 'failed to persist transfer resume state');
      }
    });
  }

  private dropResume(hostPath: string, token: string): Promise<void> {
    return this.enqueueResumeOp(this.resumeFilePath(hostPath, token), async () => {
      await rm(this.resumeFilePath(hostPath, token), { force: true }).catch(() => {});
    });
  }

  // ==========================================================================
  // PUBLIC API — called from executeToolViaRemote
  // ==========================================================================

  /**
   * pull-file: machine → workspace volume. Dispatches the tool_call (the
   * daemon opens the transfer and sends the bytes) and receives the stream.
   */
  async pullFile(args: {
    appId: string;
    workspaceId: string;
    filePath: string; // path on the machine
    destinationPath?: string; // /workspace/... (default /workspace/<basename>)
    mode?: 'create' | 'overwrite' | 'resume';
    resumeToken?: string;
    signal?: AbortSignal;
  }): Promise<TransferToolResult | { error: { code: RemoteErrorCode; message: string; hint?: string } }> {
    const key = `${args.appId}:pull`;
    if (this.pending.has(key)) {
      return { error: { code: 'BUSY', message: 'Another pull is already in flight on this device.', hint: 'Retry shortly.' } };
    }

    const destination = args.destinationPath ?? `/workspace/${basename(args.filePath)}`;
    let resolved;
    try {
      resolved = await this.resolveVolumePath(args.workspaceId, destination);
    } catch (err) {
      return { error: { code: 'INVALID_ARGUMENTS', message: err instanceof Error ? err.message : String(err) } };
    }

    const startedAt = Date.now();
    return new Promise((resolveOp) => {
      const op: PendingOp = {
        key,
        appId: args.appId,
        direction: 'pull',
        workspaceId: args.workspaceId,
        startedAt,
        resolve: resolveOp as PendingOp['resolve'],
        reject: (e) =>
          resolveOp({ error: { code: 'INTERNAL_ERROR', message: e.message } }),
      };
      this.pending.set(key, op);
      this.registerPullDestination(key, resolved);

      // Dispatch the tool_call — the daemon will send transfer.open and stream.
      this.gateway
        .dispatch(
          { appId: args.appId },
          {
            tool: 'pull-file',
            arguments: {
              filePath: args.filePath,
              destinationPath: destination,
              mode: args.mode ?? 'overwrite',
              ...(args.resumeToken ? { resumeToken: args.resumeToken } : {}),
            },
            // The transfer itself can take far longer than a normal tool call.
            timeoutMs: Math.max(this.idleTimeoutMs * 5, 300_000),
            signal: args.signal,
          },
        )
        .then((result) => {
          this.finishOp(key);
          resolveOp(this.toolResultFromDaemon(result, 'pull', args.filePath, destination, startedAt));
        })
        .catch((err) => {
          this.finishOp(key);
          resolveOp({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } });
        });
    });
  }

  /**
   * push-file: workspace volume → machine. Reads the volume file, dispatches
   * the tool_call (the daemon opens as receiver) and streams the bytes down.
   */
  async pushFile(args: {
    appId: string;
    workspaceId: string;
    sourcePath: string; // /workspace/...
    filePath: string; // destination path on the machine
    mode?: 'create' | 'overwrite' | 'resume';
    resumeToken?: string;
    signal?: AbortSignal;
  }): Promise<TransferToolResult | { error: { code: RemoteErrorCode; message: string; hint?: string } }> {
    const key = `${args.appId}:push`;
    if (this.pending.has(key)) {
      return { error: { code: 'BUSY', message: 'Another push is already in flight on this device.', hint: 'Retry shortly.' } };
    }

    let resolved;
    try {
      resolved = await this.resolveVolumePath(args.workspaceId, args.sourcePath);
    } catch (err) {
      return { error: { code: 'INVALID_ARGUMENTS', message: err instanceof Error ? err.message : String(err) } };
    }

    // Stat + hash the source up-front (the daemon verifies on close).
    let size: number;
    let sha256: string;
    try {
      const st = await stat(resolved.absPath);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
      sha256 = createHash('sha256').update(await readFile(resolved.absPath)).digest('hex');
    } catch (err) {
      return {
        error: {
          code: 'NOT_FOUND',
          message: `Source not found in the workspace volume: ${args.sourcePath}`,
          hint: 'Check the path with list-files on the workspace filesystem.',
        },
      };
    }

    const startedAt = Date.now();
    return new Promise((resolveOp) => {
      const op: PendingOp = {
        key,
        appId: args.appId,
        direction: 'push',
        workspaceId: args.workspaceId,
        startedAt,
        resolve: resolveOp as PendingOp['resolve'],
        reject: (e) => resolveOp({ error: { code: 'INTERNAL_ERROR', message: e.message } }),
      };
      this.pending.set(key, op);
      this.registerPushSource(key, { absPath: resolved.absPath, size, sha256 });

      this.gateway
        .dispatch(
          { appId: args.appId },
          {
            tool: 'push-file',
            arguments: {
              filePath: args.filePath,
              sourcePath: args.sourcePath,
              size,
              sha256,
              mode: args.mode ?? 'overwrite',
              ...(args.resumeToken ? { resumeToken: args.resumeToken } : {}),
            },
            timeoutMs: Math.max(this.idleTimeoutMs * 5, 300_000),
            signal: args.signal,
          },
        )
        .then((result) => {
          this.finishOp(key);
          resolveOp(this.toolResultFromDaemon(result, 'push', args.sourcePath, args.filePath, startedAt));
        })
        .catch((err) => {
          this.finishOp(key);
          resolveOp({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } });
        });
    });
  }

  /** Normalize the daemon's tool_result into the metadata-only tool result. */
  private toolResultFromDaemon(
    result: RemoteToolResultPayload,
    direction: 'pull' | 'push',
    sourcePath: string,
    destinationPath: string,
    startedAt: number,
  ): TransferToolResult | { error: { code: RemoteErrorCode; message: string; hint?: string } } {
    if (!result.success) {
      return {
        error: {
          code: result.error?.code ?? 'INTERNAL_ERROR',
          message: result.error?.message ?? 'transfer failed',
          ...(result.error?.hint ? { hint: result.error.hint } : {}),
        },
      };
    }
    const r = (result.result ?? {}) as Partial<TransferToolResult>;
    return {
      ok: true,
      direction,
      sourcePath,
      destinationPath,
      bytes: typeof r.bytes === 'number' ? r.bytes : 0,
      sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
      durationMs: Date.now() - startedAt,
      ...(r.resumed ? { resumed: true, resumedFromOffset: r.resumedFromOffset } : {}),
    };
  }

  // ==========================================================================
  // DIRECTORY PLANE (v0.8.0) — dir.op handler
  // ==========================================================================

  /**
   * Handle a `dir.op` envelope from a device: the daemon is orchestrating a
   * directory transfer and needs volume-side metadata (`manifest`) or a
   * volume-side `delete` (sync with delete:true). Answers with a correlated
   * `dir.result` (same envelope id). Metadata only — bytes never move here.
   */
  async handleDirOp(appId: string, envelope: RemoteEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as {
      op?: 'manifest' | 'delete';
      path?: string;
      caps?: { maxFiles?: number; maxBytes?: number };
    };
    const reply = (result: Record<string, unknown>) => {
      this.sendTo(appId, createRemoteEnvelope('dir.result', result, envelope.id));
    };

    const conn = this.gateway.getConnectedDevice({ appId });
    if (!conn) {
      reply({ ok: false, error: { code: 'MACHINE_UNREACHABLE', message: 'Device is not connected.' } });
      return;
    }
    if (!payload.path || typeof payload.path !== 'string') {
      reply({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'dir.op requires a path' } });
      return;
    }

    let resolved;
    try {
      resolved = await this.resolveVolumePath(conn.workspaceId, payload.path);
    } catch (err) {
      reply({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: err instanceof Error ? err.message : String(err) } });
      return;
    }

    if (payload.op === 'manifest') {
      const caps = {
        maxFiles: Math.max(1, Math.floor(payload.caps?.maxFiles ?? 10_000)),
        maxBytes: Math.max(1, Math.floor(payload.caps?.maxBytes ?? 10 * 1024 ** 3)),
      };
      try {
        const manifest = await this.buildVolumeManifest(resolved.absPath, payload.path, caps);
        reply({ ok: true, manifest });
      } catch (err) {
        const e = err as Error & { code?: string };
        reply({ ok: false, error: { code: e.code ?? 'INTERNAL_ERROR', message: e.message } });
      }
      return;
    }

    if (payload.op === 'delete') {
      try {
        await rm(resolved.absPath, { force: true });
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: { code: 'IO_ERROR', message: err instanceof Error ? err.message : String(err) } });
      }
      return;
    }

    reply({ ok: false, error: { code: 'INVALID_ARGUMENTS', message: `unknown dir.op: ${String(payload.op)}` } });
  }

  /** Walk a volume directory into a manifest (same shape as the daemon's). */
  private async buildVolumeManifest(
    absRoot: string,
    displayRoot: string,
    caps: { maxFiles: number; maxBytes: number },
  ): Promise<Record<string, unknown>> {
    const rootStat = await stat(absRoot).catch(() => null);
    if (!rootStat) {
      throw Object.assign(new Error(`Directory not found in the workspace volume: ${displayRoot}`), { code: 'NOT_FOUND' });
    }
    if (!rootStat.isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${displayRoot}`), { code: 'INVALID_ARGUMENTS' });
    }
    const files: { relPath: string; size: number; mtime: number; sha256: string }[] = [];
    let totalBytes = 0;
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }));
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const st = await stat(abs).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) {
          await walk(abs, relPath);
          continue;
        }
        if (!st.isFile()) continue;
        if (files.length >= caps.maxFiles) {
          throw Object.assign(
            new Error(`Directory manifest exceeds the file cap: more than ${caps.maxFiles} files under ${displayRoot}.`),
            { code: 'LIMIT_EXCEEDED' },
          );
        }
        if (totalBytes + st.size > caps.maxBytes) {
          throw Object.assign(
            new Error(`Directory manifest exceeds the byte cap: ${totalBytes + st.size} bytes > ${caps.maxBytes} under ${displayRoot}.`),
            { code: 'LIMIT_EXCEEDED' },
          );
        }
        const sha256 = createHash('sha256').update(await readFile(abs)).digest('hex');
        files.push({ relPath, size: st.size, mtime: Math.floor(st.mtimeMs), sha256 });
        totalBytes += st.size;
      }
    };
    await walk(absRoot, '');
    return {
      root: displayRoot,
      files,
      totalBytes,
      skipped: [],
      caps,
      generatedAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // INBOUND TRANSFER MESSAGES (wired from the gateway)
  // ==========================================================================

  /** Handle a transfer.* envelope from a device. Returns true when consumed. */
  handleMessage(appId: string, envelope: RemoteEnvelope): boolean {
    const type = envelope.type;
    if (!type.startsWith('transfer.')) return false;

    if (type === 'transfer.open') {
      const parsed = TransferOpenPayloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return true;
      void this.onOpen(appId, parsed.data);
      return true;
    }

    const payload = envelope.payload as { transferId?: string } | undefined;
    const transferId = payload?.transferId;
    if (!transferId) return true;

    // Find the pending op that owns this transfer.
    const op = [...this.pending.values()].find(
      (o) => o.recv?.transferId === transferId || o.send?.transferId === transferId,
    );
    if (!op) return true;

    switch (type) {
      case 'transfer.data': {
        const parsed = TransferDataPayloadSchema.safeParse(envelope.payload);
        if (parsed.success && op.recv) this.onData(appId, op, parsed.data);
        break;
      }
      case 'transfer.ack': {
        const parsed = TransferAckPayloadSchema.safeParse(envelope.payload);
        if (parsed.success && op.send) this.onAck(appId, op, parsed.data);
        break;
      }
      case 'transfer.close': {
        const parsed = TransferClosePayloadSchema.safeParse(envelope.payload);
        if (parsed.success) this.onClose(appId, op, parsed.data);
        break;
      }
    }
    return true;
  }

  /** The daemon opened a transfer — answer and set up the byte-side role. */
  private async onOpen(appId: string, openMsg: TransferOpenPayload): Promise<void> {
    const key = `${appId}:${openMsg.direction}`;
    const refuse = (
      code: 'FORBIDDEN' | 'NOT_FOUND' | 'QUOTA_EXCEEDED' | 'CONFLICT' | 'INVALID_ARGUMENTS' | 'INTERNAL_ERROR',
      message: string,
      hint?: string,
    ) => {
      const ack: TransferOpenAckPayload = {
        transferId: openMsg.transferId,
        accepted: false,
        offset: 0,
        error: { code, message, ...(hint ? { hint } : {}) },
      };
      this.sendTo(appId, createRemoteEnvelope('transfer.open_ack', ack));
    };

    // v0.8.0 (directory transfers): the daemon orchestrates one transfer per
    // file WITHOUT a per-file tool_call, so there is no pre-registered
    // PendingOp. When the open carries a `volumePath`, create an ad-hoc op
    // scoped to the connection's workspace and let the per-file branches below
    // resolve the volume path from it. Without `volumePath` an unsolicited
    // open is still a protocol error.
    let op = this.pending.get(key);
    if (!op) {
      if (!openMsg.volumePath) {
        refuse('CONFLICT', 'No pending transfer operation for this device/direction.');
        return;
      }
      const conn = this.gateway.getConnectedDevice({ appId });
      if (!conn) {
        refuse('CONFLICT', 'Device is not connected.');
        return;
      }
      op = {
        key,
        appId,
        direction: openMsg.direction,
        workspaceId: conn.workspaceId,
        startedAt: Date.now(),
        adhoc: true,
        resolve: () => {},
        reject: () => {},
      };
      this.pending.set(key, op);
    }

    if (openMsg.direction === 'pull') {
      // We receive bytes into the workspace volume. The destination was
      // resolved from OUR workspace path in pullFile — never from the
      // daemon's declared path.
      let destInfo = this.pullDestinations.get(key);
      // v0.8.0 (directory transfers): the daemon orchestrates one open per
      // file and pins the exact volume path. Re-validate it against the
      // workspace volume root — never trust the wire.
      if (!destInfo && openMsg.volumePath && op.workspaceId) {
        try {
          const resolved = await this.resolveVolumePath(op.workspaceId, openMsg.volumePath);
          destInfo = resolved;
          this.pullDestinations.set(key, resolved);
        } catch (err) {
          refuse('INVALID_ARGUMENTS', err instanceof Error ? err.message : String(err));
          return;
        }
      }
      if (!destInfo) {
        refuse('INTERNAL_ERROR', 'pull destination not registered');
        return;
      }
      const { absPath, relPath, hostPath, quota } = destInfo;

      // Quota pre-check against the declared size.
      if (openMsg.size > 0) {
        try {
          await this.checkQuota(hostPath, quota, openMsg.size);
        } catch (err) {
          refuse('QUOTA_EXCEEDED', err instanceof Error ? err.message : String(err));
          return;
        }
      }

      // Resume: pick up the durable offset if the daemon asked to resume.
      let offset = 0;
      let resumeToken = openMsg.resumeToken ?? randomUUID();
      if (openMsg.mode === 'resume' && openMsg.resumeToken) {
        const prior = await this.loadResume(hostPath, openMsg.resumeToken);
        if (prior && prior.relPath === relPath && prior.direction === 'pull') {
          offset = Math.min(prior.offset, openMsg.size >= 0 ? openMsg.size : prior.offset);
          resumeToken = prior.resumeToken;
        }
      }

      try {
        mkdirSync(dirname(absPath), { recursive: true });
        // Sync fd API: we keep the raw fd for the transfer's lifetime and close
        // it with closeSync — a promise FileHandle abandoned after .fd would
        // emit "FileHandle closed during garbage collection" warnings.
        const fd = openSync(absPath, offset > 0 && existsSync(absPath) ? 'r+' : 'w');
        // Guard: never resume past the current end of file.
        if (offset > 0) {
          const cur = fstatSync(fd).size;
          if (offset > cur) offset = cur;
        }
        const hash = createHash('sha256');
        if (offset > 0) {
          // Hash the durable prefix so the final digest covers the full file.
          const pre = Buffer.allocUnsafe(Math.min(this.chunkSize, offset));
          let pos = 0;
          while (pos < offset) {
            const want = Math.min(pre.length, offset - pos);
            const bytesRead = readSync(fd, pre, 0, want, pos);
            if (bytesRead <= 0) break;
            hash.update(pre.subarray(0, bytesRead));
            pos += bytesRead;
          }
        }
        op.recv = {
          transferId: openMsg.transferId,
          fd,
          offset,
          sinceAck: 0,
          hash,
          size: openMsg.size,
          expectedSha256: openMsg.sha256,
          resumeToken,
          absPath,
          relPath,
          idleTimer: this.armIdle(key),
        };
        await this.saveResume(hostPath, {
          resumeToken,
          transferId: openMsg.transferId,
          relPath,
          direction: 'pull',
          offset,
          size: openMsg.size,
          sha256: openMsg.sha256,
          updatedAt: new Date().toISOString(),
        });
        const ack: TransferOpenAckPayload = { transferId: openMsg.transferId, accepted: true, offset, resumeToken };
        this.sendTo(appId, createRemoteEnvelope('transfer.open_ack', ack));
      } catch (err) {
        refuse('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // push: we send bytes from the volume.
    let src = this.pushSources.get(key);
    // v0.8.0 (directory transfers): resolve the per-file volume source.
    if (!src && openMsg.volumePath && op.workspaceId) {
      try {
        const resolved = await this.resolveVolumePath(op.workspaceId, openMsg.volumePath);
        const st = await stat(resolved.absPath);
        if (!st.isFile()) throw new Error('not a regular file');
        src = {
          absPath: resolved.absPath,
          size: st.size,
          sha256: createHash('sha256').update(await readFile(resolved.absPath)).digest('hex'),
        };
        this.pushSources.set(key, src);
      } catch (err) {
        refuse('NOT_FOUND', `Source not found in the workspace volume: ${openMsg.volumePath}`);
        return;
      }
    }
    if (!src) {
      refuse('INTERNAL_ERROR', 'push source not registered');
      return;
    }
    const { absPath, size, sha256 } = src;
    const startOffset = Math.min(openMsg.offset ?? 0, size);
    op.send = {
      transferId: openMsg.transferId,
      offset: startOffset,
      seq: 0,
      inFlight: 0,
      ackedOffset: startOffset,
      size,
      hash: createHash('sha256'),
      absPath,
      eof: false,
      idleTimer: this.armIdle(key),
    };
    // Hash the skipped prefix so the final digest covers the full file.
    if (startOffset > 0) {
      const pre = Buffer.allocUnsafe(Math.min(this.chunkSize, startOffset));
      let pos = 0;
      const fh = await open(absPath, 'r');
      try {
        while (pos < startOffset) {
          const want = Math.min(pre.length, startOffset - pos);
          const { bytesRead } = await fh.read(pre, 0, want, pos);
          if (bytesRead <= 0) break;
          op.send.hash.update(pre.subarray(0, bytesRead));
          pos += bytesRead;
        }
      } finally {
        await fh.close();
      }
    }
    const ack: TransferOpenAckPayload = {
      transferId: openMsg.transferId,
      accepted: true,
      offset: startOffset,
      resumeToken: openMsg.resumeToken ?? randomUUID(),
    };
    this.sendTo(appId, createRemoteEnvelope('transfer.open_ack', ack));
    void this.pump(appId, op);
  }

  /** pull destinations / push sources registered when the tool_call is dispatched. */
  private readonly pullDestinations = new Map<string, { absPath: string; relPath: string; hostPath: string; quota: number }>();
  private readonly pushSources = new Map<string, { absPath: string; size: number; sha256: string }>();

  private onData(appId: string, op: PendingOp, data: TransferDataPayload): void {
    const r = op.recv;
    if (!r) return;
    this.rearmIdle(op.key, r.idleTimer, (t) => (r.idleTimer = t));
    const bytes = Buffer.from(data.bytes, 'base64');
    if (data.offset !== r.offset) {
      this.abortRecv(appId, op, 'IO_ERROR', `out-of-order chunk: expected ${r.offset}, got ${data.offset}`);
      return;
    }
    // Per-chunk quota check (defends against a daemon that under-declared size).
    // (Best-effort: the pre-check already covered the declared size.)
    try {
      writeSync(r.fd, bytes, 0, bytes.length, r.offset);
    } catch (err) {
      this.abortRecv(appId, op, 'IO_ERROR', err instanceof Error ? err.message : String(err));
      return;
    }
    r.hash.update(bytes);
    r.offset += bytes.length;
    r.sinceAck++;
    const destInfo = this.pullDestinations.get(op.key);
    if (destInfo) {
      void this.saveResume(destInfo.hostPath, {
        resumeToken: r.resumeToken,
        transferId: r.transferId,
        relPath: r.relPath,
        direction: 'pull',
        offset: r.offset,
        size: r.size,
        sha256: r.expectedSha256,
        updatedAt: new Date().toISOString(),
      });
    }
    if (r.sinceAck >= this.window || data.final) {
      const ack: TransferAckPayload = { transferId: r.transferId, received: r.sinceAck, nextOffset: r.offset };
      r.sinceAck = 0;
      this.sendTo(appId, createRemoteEnvelope('transfer.ack', ack));
    }
  }

  private onAck(appId: string, op: PendingOp, ack: TransferAckPayload): void {
    const s = op.send;
    if (!s) return;
    this.rearmIdle(op.key, s.idleTimer, (t) => (s.idleTimer = t));
    s.inFlight = Math.max(0, s.inFlight - ack.received);
    s.ackedOffset = Math.max(s.ackedOffset, ack.nextOffset);
    void this.pump(appId, op);
  }

  private onClose(appId: string, op: PendingOp, close: TransferClosePayload): void {
    if (op.recv && op.recv.transferId === close.transferId) {
      const r = op.recv;
      clearTimeout(r.idleTimer);
      // Verify before answering ok.
      const digest = r.hash.digest('hex');
      const expected = r.expectedSha256 ?? close.sha256;
      const destInfo = this.pullDestinations.get(op.key);
      const fail = (code: 'HASH_MISMATCH' | 'IO_ERROR', message: string) => {
        const payload: TransferClosePayload = {
          transferId: r.transferId,
          status: 'abort',
          bytesTransferred: r.offset,
          error: { code, message },
        };
        this.sendTo(appId, createRemoteEnvelope('transfer.close', payload));
        try {
          closeSync(r.fd);
        } catch {}
        op.recv = undefined;
        if (op.adhoc) this.finishOp(op.key);
      };
      if (r.size >= 0 && r.offset !== r.size) {
        fail('IO_ERROR', `short transfer: ${r.offset} of ${r.size} bytes`);
        return;
      }
      if (expected && digest !== expected) {
        fail('HASH_MISMATCH', `sha256 mismatch: computed ${digest}, expected ${expected}`);
        return;
      }
      const payload: TransferClosePayload = {
        transferId: r.transferId,
        status: 'ok',
        sha256: digest,
        bytesTransferred: r.offset,
        durationMs: Date.now() - op.startedAt,
      };
      try {
        closeSync(r.fd);
      } catch {}
      if (destInfo) {
        // Await the cleanup so a successful close leaves no resume state behind.
        void this.dropResume(destInfo.hostPath, r.resumeToken).finally(() => {
          this.sendTo(appId, createRemoteEnvelope('transfer.close', payload));
          if (op.adhoc) this.finishOp(op.key);
        });
      } else {
        this.sendTo(appId, createRemoteEnvelope('transfer.close', payload));
        if (op.adhoc) this.finishOp(op.key);
      }
      op.recv = undefined;
      return;
    }

    if (op.send && op.send.transferId === close.transferId) {
      const s = op.send;
      clearTimeout(s.idleTimer);
      s.onClosed?.(close);
      op.send = undefined;
      if (op.adhoc) this.finishOp(op.key);
    }
  }

  /** Stream chunks while the ack window allows; close when eof + all acked. */
  private async pump(appId: string, op: PendingOp): Promise<void> {
    const s = op.send;
    if (!s || s.closeSent) return;
    // Re-entrancy guard: an ack arriving while a previous pump is still
    // awaiting a read must not start a second concurrent pump (the offset /
    // inFlight bookkeeping is only consistent between awaits).
    if (s.pumping) {
      s.pumpAgain = true;
      return;
    }
    s.pumpAgain = true; // ensure the loop below runs at least once
    s.pumping = true;
    try {
      while (s.pumpAgain && !s.closeSent) {
        s.pumpAgain = false;
        const fh = await open(s.absPath, 'r');
        try {
          while (s.inFlight < this.window && !s.eof) {
            const want = Math.min(this.chunkSize, s.size - s.offset);
            if (want <= 0) {
              s.eof = true;
              break;
            }
            const buf = Buffer.allocUnsafe(want);
            const { bytesRead } = await fh.read(buf, 0, want, s.offset);
            if (bytesRead <= 0) {
              s.eof = true;
              break;
            }
            const chunk = buf.subarray(0, bytesRead);
            s.hash.update(chunk);
            const payload: TransferDataPayload = {
              transferId: s.transferId,
              seq: s.seq++,
              offset: s.offset,
              bytes: chunk.toString('base64'),
              final: s.offset + bytesRead >= s.size ? true : undefined,
            };
            s.offset += bytesRead;
            s.inFlight++;
            this.sendTo(appId, createRemoteEnvelope('transfer.data', payload));
          }
        } finally {
          await fh.close();
        }
        if (s.eof && s.inFlight === 0 && !s.closeSent) {
          // Finalize exactly once — a late ack after this point must not
          // re-enter (digest() would throw ERR_CRYPTO_HASH_FINALIZED).
          s.closeSent = true;
          s.finalHash = s.hash.digest('hex');
          const payload: TransferClosePayload = {
            transferId: s.transferId,
            status: 'ok',
            sha256: s.finalHash,
            bytesTransferred: s.offset,
            durationMs: Date.now() - op.startedAt,
          };
          this.sendTo(appId, createRemoteEnvelope('transfer.close', payload));
          // The receiver's close (verification) settles via onClose → onClosed.
        }
      }
    } finally {
      s.pumping = false;
    }
  }

  private abortRecv(appId: string, op: PendingOp, code: 'HASH_MISMATCH' | 'IO_ERROR' | 'TIMEOUT', message: string): void {
    const r = op.recv;
    if (!r) return;
    clearTimeout(r.idleTimer);
    const payload: TransferClosePayload = {
      transferId: r.transferId,
      status: 'abort',
      bytesTransferred: r.offset,
      error: { code, message },
    };
    this.sendTo(appId, createRemoteEnvelope('transfer.close', payload));
    try {
      closeSync(r.fd);
    } catch {}
    op.recv = undefined;
    if (op.adhoc) this.finishOp(op.key);
  }

  private armIdle(key: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const op = this.pending.get(key);
      if (!op) return;
      log.warn({ key }, 'transfer idle timeout — aborting');
      if (op.recv) this.abortRecv(op.appId, op, 'TIMEOUT', `no progress for ${this.idleTimeoutMs}ms`);
      op.send = undefined;
    }, this.idleTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private rearmIdle(key: string, current: ReturnType<typeof setTimeout>, set: (t: ReturnType<typeof setTimeout>) => void): void {
    clearTimeout(current);
    set(this.armIdle(key));
  }

  private finishOp(key: string): void {
    const op = this.pending.get(key);
    if (!op) return;
    if (op.recv) clearTimeout(op.recv.idleTimer);
    if (op.send) clearTimeout(op.send.idleTimer);
    this.pending.delete(key);
    this.pullDestinations.delete(key);
    this.pushSources.delete(key);
  }

  /** Send an envelope down the device's tunnel. */
  private sendTo(appId: string, envelope: RemoteEnvelope): void {
    // The gateway owns the socket; expose a narrow send through it.
    this.gateway.sendEnvelope({ appId }, envelope);
  }

  /** Register the byte-side context for a pending op (called before dispatch). */
  registerPullDestination(key: string, info: { absPath: string; relPath: string; hostPath: string; quota: number }): void {
    this.pullDestinations.set(key, info);
  }
  registerPushSource(key: string, info: { absPath: string; size: number; sha256: string }): void {
    this.pushSources.set(key, info);
  }
}
