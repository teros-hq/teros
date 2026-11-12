/**
 * fs.list / fs.write / file.watch authorize the caller on the volume's workspace.
 *
 * All three take a client-supplied workspaceId or channelId and resolve it to a
 * workspace volume on disk (resolveVolumeHostPath), which never looked at the
 * caller. Any logged-in user who had (or guessed) another workspace's id — a
 * removed member, say — could list its files, overwrite them (AGENTS.md, code
 * the agents run) or stream them live. /api/files got this check in SEC-2 A3;
 * these WS twins did not.
 *
 * Real files in a temp volume; Db mocked (workspaces, workspace_members, channels).
 */

import { afterAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WsHandlerContext } from '@teros/shared';
import { createFsListHandler } from '../../src/handlers/domains/fs-browser/list';
import { createFsWriteHandler } from '../../src/handlers/domains/fs-browser/write';
import {
  cleanupWatcherRegistry,
  createWatchFileHandler,
  createWatcherRegistry,
  fileWatchTopic,
} from '../../src/handlers/domains/file-watcher/watch';

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'fs-authz-')));
const VOL = join(BASE, 'vol_a');
mkdirSync(VOL, { recursive: true });
writeFileSync(join(VOL, 'AGENTS.md'), 'original');
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const OWNER = 'user_owner';
const WRITER = 'user_writer';
const READER = 'user_reader';
const PENDING = 'user_pending';
const STRANGER = 'user_stranger';

const MEMBERS: Record<string, { role?: string; status?: string }> = {
  [WRITER]: { role: 'write' },
  [READER]: {},
  [PENDING]: { role: 'write', status: 'pending' },
};

function makeDeps() {
  const db = {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === 'workspaces') {
          return filter.workspaceId === 'work_a' ? { workspaceId: 'work_a', ownerId: OWNER, status: 'active' } : null;
        }
        if (name === 'workspace_members') {
          const m = filter.workspaceId === 'work_a' ? MEMBERS[filter.userId] : undefined;
          return m ? { workspaceId: 'work_a', userId: filter.userId, ...m } : null;
        }
        if (name === 'channels') {
          return filter.channelId === 'ch_a' ? { channelId: 'ch_a', workspaceId: 'work_a' } : null;
        }
        return null;
      },
    }),
  } as any;
  const workspaceService = {
    getWorkspace: mock(async (id: string) => (id === 'work_a' ? { workspaceId: 'work_a', volumeId: 'vol_a' } : null)),
  } as any;
  const volumeService = { getVolume: mock(async () => ({ volumeId: 'vol_a', hostPath: VOL })) } as any;
  return { db, workspaceService, volumeService };
}

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: 's1', connectionId: 'c1', ws: {} }) as any;

describe('fs.write', () => {
  const write = (userId: string, data: Record<string, unknown>) =>
    createFsWriteHandler(makeDeps())(ctx(userId), { filePath: '/workspace/AGENTS.md', content: 'pwned', ...data });

  it('rejects a user outside the workspace, and the file is untouched', async () => {
    await expect(write(STRANGER, { workspaceId: 'work_a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readFileSync(join(VOL, 'AGENTS.md'), 'utf-8')).toBe('original');
  });

  it('rejects a stranger going through one of the workspace channels', async () => {
    await expect(write(STRANGER, { channelId: 'ch_a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readFileSync(join(VOL, 'AGENTS.md'), 'utf-8')).toBe('original');
  });

  it('rejects a read-only member and a pending invitee', async () => {
    await expect(write(READER, { workspaceId: 'work_a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(write(PENDING, { workspaceId: 'work_a' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(readFileSync(join(VOL, 'AGENTS.md'), 'utf-8')).toBe('original');
  });

  it('lets a member with the write role write', async () => {
    const res = await createFsWriteHandler(makeDeps())(ctx(WRITER), {
      filePath: '/workspace/notes.md',
      content: 'hello',
      workspaceId: 'work_a',
    });
    expect(res.bytesWritten).toBe(5);
    expect(readFileSync(join(VOL, 'notes.md'), 'utf-8')).toBe('hello');
  });

  it('lets the owner write through a channel of the workspace', async () => {
    await createFsWriteHandler(makeDeps())(ctx(OWNER), {
      filePath: '/workspace/from-channel.md',
      content: 'x',
      channelId: 'ch_a',
    });
    expect(existsSync(join(VOL, 'from-channel.md'))).toBe(true);
  });
});

describe('fs.list', () => {
  it('rejects a user outside the workspace before resolving the volume', async () => {
    const deps = makeDeps();
    await expect(
      createFsListHandler(deps)(ctx(STRANGER), { workspaceId: 'work_a', path: '/workspace' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(deps.workspaceService.getWorkspace).not.toHaveBeenCalled();
  });

  it('lets a read-only member list', async () => {
    const res: any = await createFsListHandler(makeDeps())(ctx(READER), { workspaceId: 'work_a', path: '/workspace' });
    expect(JSON.stringify(res)).toContain('AGENTS.md');
  });
});

describe('file.watch', () => {
  it('rejects a user outside the workspace and never subscribes or broadcasts', async () => {
    const registry = createWatcherRegistry();
    const pubSubService = {
      subscribeSession: mock(() => {}),
      unsubscribeSession: mock(() => {}),
      broadcastToTopic: mock(() => {}),
    } as any;
    const h = createWatchFileHandler({
      ...makeDeps(),
      pubSubService,
      getSessionId: () => 's1',
      getRegistry: () => registry,
      waitForFileRetries: 1,
      waitForFileDelayMs: 1,
    });

    await expect(h(ctx(STRANGER), { filePath: '/workspace/AGENTS.md', workspaceId: 'work_a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(h(ctx(STRANGER), { filePath: '/workspace/AGENTS.md', channelId: 'ch_a' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(pubSubService.subscribeSession).not.toHaveBeenCalled();
    expect(pubSubService.broadcastToTopic).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
    cleanupWatcherRegistry(registry);
  });
});

describe('file.watch topic isolation', () => {
  it('the same filePath in two volumes maps to two topics, and the host path never leaks', () => {
    const a = fileWatchTopic('/vol/work_a/index.html', '/workspace/index.html');
    const b = fileWatchTopic('/vol/work_b/index.html', '/workspace/index.html');
    expect(a).not.toBe(b);
    expect(a.endsWith(':/workspace/index.html')).toBe(true);
    expect(a).not.toContain('/vol/');
  });
});
