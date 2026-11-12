/**
 * Directory plane loopback E2E (v0.8.0, REQ-14; AC-14 + directory AC-15).
 *
 * Same in-memory transport as remote-transfer-e2e.test.ts, but exercising the
 * DIRECTORY tools: the REAL daemon directory tools (manifest + pull/push/sync,
 * imported from the sibling clone) orchestrate per-file transfers against the
 * REAL backend RemoteTransferService, with dir.op (volume manifest / delete)
 * answered by the service through the same transport.
 *
 * This proves AC-14 semantics (dry-run diff added/changed/deleted, delta-only
 * apply, deletions opt-in) and the directory resume variant (completed files
 * are skipped on re-run) WITHOUT midgar — the on-device E2E is still the
 * final gate, gated on midgar being online.
 *
 * Run: bun test packages/backend/tests/unit/remote-directory-e2e.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteTransferService } from '../../src/services/remote-transfer-service';
import type { TransferManager as TransferManagerT } from '/workspace/teros-remote/packages/daemon/src/transfer';
import type * as DirectoryToolsT from '/workspace/teros-remote/packages/daemon/src/directory-tools';
import type { DirectoryOps } from '/workspace/teros-remote/packages/daemon/src/directory-tools';
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
const { createPullDirectoryTool, createPushDirectoryTool, createSyncDirectoryTool } = hasDaemon
  ? await import(join(DAEMON_SRC, 'directory-tools'))
  : ({} as typeof DirectoryToolsT);
const { RootPolicy } = hasDaemon
  ? await import(join(DAEMON_SRC, 'fs/lib/root-policy'))
  : ({} as { RootPolicy: typeof RootPolicyT });

const tick = () => new Promise((r) => setImmediate(r));

let machineDir: string;
let volumeDir: string;
let daemon: TransferManagerT;
let service: RemoteTransferService;
let dirOps: DirectoryOps;
let pullDirTool: ReturnType<typeof DirectoryToolsT.createPullDirectoryTool>;
let pushDirTool: ReturnType<typeof DirectoryToolsT.createPushDirectoryTool>;
let syncDirTool: ReturnType<typeof DirectoryToolsT.createSyncDirectoryTool>;

const APP_ID = 'app_test_dir';
const WS_ID = 'work_test_dir';
const CAPS = { maxFiles: 1_000, maxBytes: 100 * 1024 ** 2 };

let toDaemon: any[];
let toBackend: any[];

async function flush() {
  for (let i = 0; i < 2000; i++) {
    await tick();
    const d = toDaemon.splice(0);
    const b = toBackend.splice(0);
    if (!d.length && !b.length) return;
    for (const e of d) {
      if (e.type === 'dir.result') dirOpsHandle(e);
      else daemon.handleMessage(e);
    }
    for (const e of b) {
      if (e.type === 'dir.op') {
        void service.handleDirOp(APP_ID, e);
      } else {
        service.handleMessage(APP_ID, e);
      }
    }
  }
}

// The daemon's DirOpsBridge sends dir.op and resolves on dir.result — emulate
// that correlation here (the bridge itself is thin; tested implicitly).
const dirWaiters = new Map<string, (r: any) => void>();
function dirOpsHandle(envelope: any) {
  const w = dirWaiters.get(envelope.id);
  if (w) {
    dirWaiters.delete(envelope.id);
    w(envelope.payload);
  }
}

const fakeGateway = {
  // The directory tools run ON the daemon; the backend never dispatches them.
  // dispatch is only here for completeness (unused in this suite).
  dispatch: async () => ({ success: false, duration: 0, error: { code: 'TOOL_NOT_FOUND', message: 'n/a' } }),
  sendEnvelope: (_t: any, envelope: any) => {
    toDaemon.push(envelope);
    return true;
  },
  getConnectedDevice: () => ({ deviceId: 'dev_dir', appId: APP_ID, sessionId: 'sess', hello: {}, inFlight: 0, workspaceId: WS_ID }),
};

const fakeVolumeService = { getVolume: async () => ({ volumeId: 'vol_test', hostPath: volumeDir, quota: 0 }) };
const fakeWorkspaceService = { getWorkspace: async () => ({ workspaceId: WS_ID, volumeId: 'vol_test' }) };

beforeEach(() => {
  if (!hasDaemon) return;
  machineDir = join(tmpdir(), `e2e-dir-machine-${randomUUID().slice(0, 8)}`);
  volumeDir = join(tmpdir(), `e2e-dir-volume-${randomUUID().slice(0, 8)}`);
  mkdirSync(machineDir, { recursive: true });
  mkdirSync(volumeDir, { recursive: true });
  toDaemon = [];
  toBackend = [];
  dirWaiters.clear();

  daemon = new TransferManager({
    policy: new RootPolicy([machineDir]),
    send: (e) => toBackend.push(e),
    chunkSize: 64 * 1024,
    window: 4,
    idleTimeoutMs: 10_000,
  });

  service = new RemoteTransferService({
    gateway: fakeGateway as never,
    volumeService: fakeVolumeService as never,
    workspaceService: fakeWorkspaceService as never,
    chunkSize: 64 * 1024,
    window: 4,
    idleTimeoutMs: 10_000,
  });

  // DirectoryOps bridge over the same transport: dir.op → service, wait dir.result.
  dirOps = {
    volumeManifest: async (path: string, caps: any) => {
      const id = randomUUID();
      const result = await new Promise<any>((resolve) => {
        dirWaiters.set(id, resolve);
        toBackend.push({ id, type: 'dir.op', timestamp: new Date().toISOString(), version: 1, payload: { op: 'manifest', path, caps } });
      });
      if (!result.ok) {
        const err: any = new Error(result.error?.message ?? 'manifest failed');
        err.code = result.error?.code;
        throw err;
      }
      return result.manifest;
    },
    volumeDelete: async (path: string) => {
      const id = randomUUID();
      const result = await new Promise<any>((resolve) => {
        dirWaiters.set(id, resolve);
        toBackend.push({ id, type: 'dir.op', timestamp: new Date().toISOString(), version: 1, payload: { op: 'delete', path } });
      });
      if (!result.ok) {
        const err: any = new Error(result.error?.message ?? 'delete failed');
        err.code = result.error?.code;
        throw err;
      }
    },
  };

  const dirToolOpts = {
    transfers: daemon,
    policy: new RootPolicy([machineDir]),
    dirOps,
    caps: CAPS,
  };
  pullDirTool = createPullDirectoryTool(dirToolOpts);
  pushDirTool = createPushDirectoryTool(dirToolOpts);
  syncDirTool = createSyncDirectoryTool(dirToolOpts);
});

afterEach(async () => {
  if (!hasDaemon) return;
  daemon.abortAll('test cleanup');
  await flush();
  await tick();
  rmSync(machineDir, { recursive: true, force: true });
  rmSync(volumeDir, { recursive: true, force: true });
});

const sha256file = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Run a daemon directory tool while pumping the transport until it settles. */
async function runDirTool(tool: { handler: (a: any) => Promise<unknown> }, args: Record<string, unknown>): Promise<any> {
  let settled = false;
  const resultPromise = tool.handler(args).finally(() => {
    settled = true;
  });
  const pumper = (async () => {
    let extra = 10;
    while (!settled || extra-- > 0) {
      await flush();
      await tick();
    }
  })();
  const [result] = await Promise.all([resultPromise, pumper]);
  return result;
}

/** Seed a machine-side tree: base.txt (shared), changed.txt, deleted.txt. */
function seedMachine() {
  mkdirSync(join(machineDir, 'proj/sub'), { recursive: true });
  writeFileSync(join(machineDir, 'proj/base.txt'), 'base-content');
  writeFileSync(join(machineDir, 'proj/changed.txt'), 'new-version');
  writeFileSync(join(machineDir, 'proj/sub/added.txt'), 'brand new file');
}
/** Seed the matching volume-side tree: base identical, changed differs, plus a file the machine lacks. */
function seedVolume() {
  mkdirSync(join(volumeDir, 'proj/sub'), { recursive: true });
  writeFileSync(join(volumeDir, 'proj/base.txt'), 'base-content');
  writeFileSync(join(volumeDir, 'proj/changed.txt'), 'old-version');
  writeFileSync(join(volumeDir, 'proj/deleted.txt'), 'only on volume');
}

describe.skipIf(!hasDaemon)('directory plane loopback E2E (daemon tools ↔ backend service)', () => {
  it('AC-14: sync-directory dryRun reports added/changed/deleted exactly', async () => {
    seedMachine();
    seedVolume();

    const report = await runDirTool(syncDirTool, {
      direction: 'pull',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.diff.added).toEqual(['sub/added.txt']);
    expect(report.diff.changed).toEqual(['changed.txt']);
    expect(report.diff.deleted).toEqual(['deleted.txt']);
    expect(report.diff.unchanged).toBe(1); // base.txt
    expect(report.filesTransferred).toBe(0);
    // dryRun must not have moved a single byte
    expect(readFileSync(join(volumeDir, 'proj/changed.txt'), 'utf8')).toBe('old-version');
    expect(existsSync(join(volumeDir, 'proj/sub/added.txt'))).toBe(false);
  }, 30_000);

  it('AC-14: apply transfers only the delta; without delete:true nothing is deleted', async () => {
    seedMachine();
    seedVolume();

    const report = await runDirTool(syncDirTool, {
      direction: 'pull',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: false,
    });

    expect(report.ok).toBe(true);
    expect(report.filesTransferred).toBe(2); // added + changed only
    expect(report.filesSkipped).toBe(1); // base.txt unchanged
    // Delta applied
    expect(sha256file(join(volumeDir, 'proj/changed.txt'))).toBe(sha256file(join(machineDir, 'proj/changed.txt')));
    expect(sha256file(join(volumeDir, 'proj/sub/added.txt'))).toBe(sha256file(join(machineDir, 'proj/sub/added.txt')));
    // NOT deleted (no delete:true) — reported instead
    expect(existsSync(join(volumeDir, 'proj/deleted.txt'))).toBe(true);
    expect(report.deleteSkipped).toEqual(['deleted.txt']);
    expect(report.deletedFiles).toBeUndefined();
  }, 30_000);

  it('AC-14: with delete:true the reported deletions are applied', async () => {
    seedMachine();
    seedVolume();

    const report = await runDirTool(syncDirTool, {
      direction: 'pull',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: false,
      delete: true,
    });

    expect(report.ok).toBe(true);
    expect(report.deletedFiles).toEqual(['deleted.txt']);
    expect(existsSync(join(volumeDir, 'proj/deleted.txt'))).toBe(false);
  }, 30_000);

  it('AC-14: a second dryRun after apply reports no delta (converged)', async () => {
    seedMachine();
    seedVolume();
    await runDirTool(syncDirTool, {
      direction: 'pull',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: false,
      delete: true,
    });
    const report = await runDirTool(syncDirTool, {
      direction: 'pull',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: true,
    });
    expect(report.diff.added).toEqual([]);
    expect(report.diff.changed).toEqual([]);
    expect(report.diff.deleted).toEqual([]);
    expect(report.diff.unchanged).toBe(3);
  }, 30_000);

  it('pull-directory transfers a tree and re-run skips completed files (directory resume, AC-15 variant)', async () => {
    seedMachine();

    const first = await runDirTool(pullDirTool, {
      directoryPath: join(machineDir, 'proj'),
      destinationPath: '/workspace/pulled',
    });
    expect(first.ok).toBe(true);
    expect(first.filesTransferred).toBe(3);
    expect(first.filesSkipped).toBe(0);
    expect(sha256file(join(volumeDir, 'pulled/base.txt'))).toBe(sha256file(join(machineDir, 'proj/base.txt')));
    expect(sha256file(join(volumeDir, 'pulled/sub/added.txt'))).toBe(sha256file(join(machineDir, 'proj/sub/added.txt')));

    // Re-run with no changes: everything is already complete → all skipped.
    const second = await runDirTool(pullDirTool, {
      directoryPath: join(machineDir, 'proj'),
      destinationPath: '/workspace/pulled',
    });
    expect(second.ok).toBe(true);
    expect(second.filesTransferred).toBe(0);
    expect(second.filesSkipped).toBe(3);
  }, 30_000);

  it('push-directory transfers a volume tree onto the machine', async () => {
    seedVolume();

    const report = await runDirTool(pushDirTool, {
      sourcePath: '/workspace/proj',
      directoryPath: join(machineDir, 'from-volume'),
    });
    expect(report.ok).toBe(true);
    expect(report.filesTransferred).toBe(3);
    expect(sha256file(join(machineDir, 'from-volume/base.txt'))).toBe(sha256file(join(volumeDir, 'proj/base.txt')));
    expect(sha256file(join(machineDir, 'from-volume/deleted.txt'))).toBe(sha256file(join(volumeDir, 'proj/deleted.txt')));
  }, 30_000);

  it('sync push direction: volume is the source, machine is the destination', async () => {
    seedMachine();
    seedVolume();

    const dry = await runDirTool(syncDirTool, {
      direction: 'push',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: true,
    });
    // From the volume's perspective: added = deleted.txt, changed = changed.txt, deleted = sub/added.txt
    expect(dry.diff.added).toEqual(['deleted.txt']);
    expect(dry.diff.changed).toEqual(['changed.txt']);
    expect(dry.diff.deleted).toEqual(['sub/added.txt']);

    const applied = await runDirTool(syncDirTool, {
      direction: 'push',
      directoryPath: join(machineDir, 'proj'),
      workspacePath: '/workspace/proj',
      dryRun: false,
      delete: true,
    });
    expect(applied.ok).toBe(true);
    expect(sha256file(join(machineDir, 'proj/changed.txt'))).toBe(sha256file(join(volumeDir, 'proj/changed.txt')));
    expect(existsSync(join(machineDir, 'proj/deleted.txt'))).toBe(true);
    expect(existsSync(join(machineDir, 'proj/sub/added.txt'))).toBe(false);
  }, 30_000);
});
