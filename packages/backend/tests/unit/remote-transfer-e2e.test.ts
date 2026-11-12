/**
 * Transfer plane loopback E2E (v0.7.0, REQ-14; AC-12/13/15).
 *
 * Wires the REAL backend RemoteTransferService against the REAL daemon
 * TransferManager (imported from the sibling clone at /workspace/teros-remote)
 * through an in-memory transport. The fake gateway emulates the daemon's
 * tool-call entry points (pull-file/push-file handlers) so the full message
 * flow runs: tool_call → transfer.open → data/ack window → close(sha256).
 *
 * This is NOT a substitute for the on-device E2E against midgar — that one
 * needs daemon 0.7.0 deployed on midgar and the RAW backend restarted with
 * this code, both of which are gated on Pablo. What it DOES prove is that the
 * two implementations speak the same protocol and meet the acceptance
 * criteria semantics (hashes match, metadata-only results, FORBIDDEN outside
 * roots, resume from the last acked offset).
 *
 * Run: bun test packages/backend/tests/unit/remote-transfer-e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteTransferService } from '../../src/services/remote-transfer-service';
import type { TransferManager as TransferManagerT } from '/workspace/teros-remote/packages/daemon/src/transfer';
import type * as TransferToolsT from '/workspace/teros-remote/packages/daemon/src/transfer-tools';
import type { RootPolicy as RootPolicyT } from '/workspace/teros-remote/packages/daemon/src/fs/lib/root-policy';

// The daemon half lives in the sibling teros-remote clone (TEROS_REMOTE_DIR,
// default /workspace/teros-remote). Without it — CI, most worktrees — the
// static imports used to abort the file as an "Unhandled error between tests";
// now the suites are skipped and say why.
const TEROS_REMOTE = process.env.TEROS_REMOTE_DIR ?? '/workspace/teros-remote';
const DAEMON_SRC = join(TEROS_REMOTE, 'packages/daemon/src');
const hasDaemon = existsSync(join(DAEMON_SRC, 'transfer.ts'));
if (!hasDaemon) console.warn(`[remote e2e] skipped: no teros-remote daemon at ${DAEMON_SRC}`);
const { TransferManager } = hasDaemon
  ? await import(join(DAEMON_SRC, 'transfer'))
  : ({} as { TransferManager: typeof TransferManagerT });
const { createPullFileTool, createPushFileTool } = hasDaemon
  ? await import(join(DAEMON_SRC, 'transfer-tools'))
  : ({} as typeof TransferToolsT);
const { RootPolicy } = hasDaemon
  ? await import(join(DAEMON_SRC, 'fs/lib/root-policy'))
  : ({} as { RootPolicy: typeof RootPolicyT });

const tick = () => new Promise((r) => setImmediate(r));

let machineDir: string; // the "remote machine" filesystem root
let volumeDir: string; // the workspace volume hostPath
let daemon: TransferManagerT;
let service: RemoteTransferService;
let pullTool: ReturnType<typeof TransferToolsT.createPullFileTool>;
let pushTool: ReturnType<typeof TransferToolsT.createPushFileTool>;

const APP_ID = 'app_test_transfer';
const WS_ID = 'work_test_transfer';

/** Envelopes in flight, per side. */
let toDaemon: any[];
let toBackend: any[];
let dropMode: { afterBytes: number; seen: number } | null;

async function flush() {
  // Pump both queues until quiescent.
  for (let i = 0; i < 1000; i++) {
    await tick();
    const d = toDaemon.splice(0);
    const b = toBackend.splice(0);
    if (!d.length && !b.length) return;
    for (const e of d) daemon.handleMessage(e);
    for (const e of b) {
      if (dropMode && e.type === 'transfer.data') {
        // Simulate tunnel loss mid-stream (daemon → backend direction, i.e. pull).
        if (dropMode.seen >= dropMode.afterBytes) continue;
        dropMode.seen += Buffer.from(e.payload.bytes, 'base64').length;
      }
      service.handleMessage(APP_ID, e);
    }
  }
}

/** Fake gateway: dispatch invokes the daemon tool handlers; sendEnvelope routes to the daemon. */
const fakeGateway = {
  dispatch: async (_target: any, call: any) => {
    const tool = call.tool === 'pull-file' ? pullTool : pushTool;
    try {
      let settled = false;
      const resultPromise = tool.handler(call.arguments).finally(() => {
        settled = true;
      });
      // Pump the transport until the handler settles (deterministic stop) —
      // plus a few extra rounds to deliver the final close handshake.
      const pumper = (async () => {
        let extra = 10;
        while (!settled || extra-- > 0) {
          await flush();
          await tick();
        }
      })();
      const [result] = await Promise.all([resultPromise, pumper]);
      return { success: true, duration: 0, result };
    } catch (err: any) {
      return {
        success: false,
        duration: 0,
        error: { code: err.code ?? 'INTERNAL_ERROR', message: err.message, hint: err.hint },
      };
    }
  },
  sendEnvelope: (_target: any, envelope: any) => {
    toDaemon.push(envelope);
    return true;
  },
};

const fakeVolumeService = {
  getVolume: async () => ({ volumeId: 'vol_test', hostPath: volumeDir, quota: 0 }),
};
const fakeWorkspaceService = {
  getWorkspace: async () => ({ workspaceId: WS_ID, volumeId: 'vol_test' }),
};

beforeEach(() => {
  if (!hasDaemon) return;
  machineDir = join(tmpdir(), `e2e-machine-${randomUUID().slice(0, 8)}`);
  volumeDir = join(tmpdir(), `e2e-volume-${randomUUID().slice(0, 8)}`);
  mkdirSync(machineDir, { recursive: true });
  mkdirSync(volumeDir, { recursive: true });
  toDaemon = [];
  toBackend = [];
  dropMode = null;

  daemon = new TransferManager({
    policy: new RootPolicy([machineDir]),
    send: (e) => toBackend.push(e),
    chunkSize: 64 * 1024, // 64KB chunks so 1MB exercises the window
    window: 4,
    idleTimeoutMs: 10_000,
  });
  pullTool = createPullFileTool(daemon);
  pushTool = createPushFileTool(daemon);

  service = new RemoteTransferService({
    gateway: fakeGateway as never,
    volumeService: fakeVolumeService as never,
    workspaceService: fakeWorkspaceService as never,
    chunkSize: 64 * 1024,
    window: 4,
    idleTimeoutMs: 10_000,
  });
});

afterEach(async () => {
  if (!hasDaemon) return;
  daemon.abortAll('test cleanup');
  // Let aborted transfers settle (rejections, fd closes, queued resume writes)
  // before wiping the dirs — otherwise a late flush hits a deleted path and
  // the suite reports unhandled errors between tests.
  await flush();
  await tick();
  rmSync(machineDir, { recursive: true, force: true });
  rmSync(volumeDir, { recursive: true, force: true });
});

const sha256file = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe.skipIf(!hasDaemon)('transfer plane loopback E2E (backend service ↔ daemon manager)', () => {
  it('AC-12: pull of a >1MB binary lands in the volume with matching sha256 and a metadata-only result', async () => {
    const content = randomBytesLike(1_500_000);
    const src = join(machineDir, 'big.bin');
    writeFileSync(src, content);

    const result = (await service.pullFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      filePath: src,
    })) as any;

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.direction).toBe('pull');
    expect(result.bytes).toBe(content.length);
    const dest = join(volumeDir, 'big.bin');
    expect(sha256file(dest)).toBe(sha256file(src));
    expect(result.sha256).toBe(sha256file(src));
    // metadata-only: no content/base64 field anywhere in the result
    expect(JSON.stringify(result)).not.toContain(content.subarray(0, 64).toString('base64'));
  }, 30_000);

  it('AC-13: push lands on the machine with matching sha256', async () => {
    const content = randomBytesLike(900_000);
    writeFileSync(join(volumeDir, 'pushme.bin'), content);

    const dest = join(machineDir, 'pushed.bin');
    const result = (await service.pushFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      sourcePath: '/workspace/pushme.bin',
      filePath: dest,
    })) as any;

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(content.length);
    expect(sha256file(dest)).toBe(sha256file(join(volumeDir, 'pushme.bin')));
  }, 30_000);

  it('AC-13: pull from a path outside the daemon roots fails FORBIDDEN', async () => {
    const result = (await service.pullFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      filePath: '/etc/passwd',
    })) as any;
    expect(result.error).toBeTruthy();
    expect(result.error.code).toBe('FORBIDDEN');
  }, 30_000);

  it('AC-13: push to a path outside the daemon roots fails FORBIDDEN', async () => {
    writeFileSync(join(volumeDir, 'x.bin'), Buffer.alloc(1024, 1));
    const result = (await service.pushFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      sourcePath: '/workspace/x.bin',
      filePath: '/etc/evil.bin',
    })) as any;
    expect(result.error).toBeTruthy();
    expect(result.error.code).toBe('FORBIDDEN');
  }, 30_000);
});

describe.skipIf(!hasDaemon)('AC-15: resume after an interrupted transfer', () => {
  it('pull interrupted mid-stream resumes from the last acked offset and completes with matching hash', async () => {
    const content = randomBytesLike(1_000_000);
    const src = join(machineDir, 'resume.bin');
    writeFileSync(src, content);

    // First attempt: drop data frames after ~300KB (simulated tunnel loss),
    // which starves the daemon's sender until the idle timeout aborts it.
    dropMode = { afterBytes: 300_000, seen: 0 };
    const first = (await service.pullFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      filePath: src,
    })) as any;
    expect(first.error).toBeTruthy(); // interrupted — TIMEOUT from the idle watchdog
    dropMode = null;

    // The backend receiver persisted its durable offset under .teros/transfers.
    const resumeDir = join(volumeDir, '.teros', 'transfers');
    const tokens = readdirSync(resumeDir).filter((f) => f.endsWith('.json'));
    expect(tokens.length).toBe(1);
    const state = JSON.parse(readFileSync(join(resumeDir, tokens[0]), 'utf8'));
    expect(state.offset).toBeGreaterThan(0);
    expect(state.offset).toBeLessThan(content.length);

    // Second attempt: resume with the token — must complete from that offset.
    const second = (await service.pullFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      filePath: src,
      mode: 'resume',
      resumeToken: state.resumeToken,
    })) as any;

    expect(second.error).toBeUndefined();
    expect(second.ok).toBe(true);
    expect(second.bytes).toBe(content.length);
    const dest = join(volumeDir, 'resume.bin');
    expect(sha256file(dest)).toBe(sha256file(src));
    // Resume state cleaned up after success.
    expect(readdirSync(resumeDir).filter((f) => f.endsWith('.json')).length).toBe(0);
  }, 60_000);
});

describe.skipIf(!hasDaemon)('regression: late ack after close must not crash the sender', () => {
  it('a duplicate/tardy ack arriving after the close frame is a no-op (no double digest)', async () => {
    const content = randomBytesLike(200_000);
    writeFileSync(join(volumeDir, 'late.bin'), content);
    const dest = join(machineDir, 'late.bin');

    // Intercept backend→daemon frames: after the close goes out, inject a
    // duplicate ack for the same transfer before delivering the close.
    let injected = false;
    let closeSeen = false;
    const origSend = (service as never as { sendTo: (a: string, e: never) => void }).sendTo.bind(
      service,
    );
    (service as never as { sendTo: (a: string, e: never) => void }).sendTo = (
      appId: string,
      envelope: { type: string; payload: { transferId?: string; received?: number; nextOffset?: number } },
    ) => {
      if (envelope.type === 'transfer.close' && !closeSeen) {
        closeSeen = true;
        // First deliver the close to the daemon, THEN hand the BACKEND a
        // tardy duplicate ack (post-close) — the sender side must ignore it.
        origSend(appId, envelope as never);
        toBackend.push({
          type: 'transfer.ack',
          payload: {
            transferId: envelope.payload.transferId,
            received: 1,
            nextOffset: content.length,
          },
        });
        injected = true;
        return;
      }
      origSend(appId, envelope as never);
    };

    const result = (await service.pushFile({
      appId: APP_ID,
      workspaceId: WS_ID,
      sourcePath: '/workspace/late.bin',
      filePath: dest,
    })) as { error?: { code: string; message: string }; ok?: boolean; bytes?: number };

    expect(injected).toBe(true); // the tardy ack really went in after the close
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(sha256file(dest)).toBe(sha256file(join(volumeDir, 'late.bin')));
  }, 30_000);
});

function randomBytesLike(n: number): Buffer {
  // Deterministic-ish pseudo-random content (fast, compressible-ish, binary).
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 2654435761) & 0xff;
  return buf;
}
