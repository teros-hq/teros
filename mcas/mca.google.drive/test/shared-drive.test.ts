/**
 * Regression + structural guard for Shared Drive support (TER-514).
 *
 * Bug: every Drive API `files.*` / `permissions.*` call needs `supportsAllDrives=true`
 * (and `files.list` also `includeItemsFromAllDrives=true` + `corpora=allDrives`) or the
 * API returns `404 File not found` for items inside a shared drive, even when the user
 * has access. None of the tools passed these params.
 *
 * Two layers:
 *  1. Behavioral — drive the real handler against a faithful mock of the googleapis
 *     client and assert the EXACT params that reach the boundary.
 *  2. Structural — scan the source so a future tool cannot reintroduce the bug
 *     (every gated call-site must spread ALL_DRIVES / ALL_DRIVES_LIST).
 */

import { describe, expect, it, mock } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS_DIR = join(import.meta.dir, '../src/tools');

// ---------------------------------------------------------------------------
// Faithful mock of the googleapis Drive client. Each method records the exact
// params object it received and returns a minimal shaped response.
// ---------------------------------------------------------------------------
function makeDrive() {
  const calls: Record<string, any> = {};
  const record = (name: string, data: any) =>
    mock(async (params: any) => {
      calls[name] = params;
      return { data };
    });
  const drive = {
    files: {
      list: record('list', { files: [], nextPageToken: 'tok', incompleteSearch: false }),
      get: record('get', { id: 'f1', name: 'n', parents: ['p0'], mimeType: 'text/plain' }),
      create: record('create', { id: 'f1', name: 'n' }),
      update: record('update', { id: 'f1', name: 'n' }),
      copy: record('copy', { id: 'f2', name: 'copy' }),
      delete: record('delete', {}),
    },
    permissions: {
      create: record('permCreate', { id: 'perm1', role: 'reader' }),
    },
  };
  return { drive, calls };
}

// Mock the lib barrel so handlers use our fake client and run the operation inline.
function installLibMock(drive: any) {
  mock.module('../src/lib', () => ({
    initializeGoogleClients: async () => ({ drive }),
    ensureAuthenticated: async () => {},
    withAuthRetry: async (_ctx: any, op: () => Promise<any>) => op(),
    // helpers some tools also import from the barrel:
    saveToDownloads: async () => '/tmp/x',
    ALL_DRIVES: { supportsAllDrives: true },
    ALL_DRIVES_LIST: {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    },
  }));
}

const ctx = {} as any;

describe('shared-drive constants (real values, not the barrel mock)', () => {
  // Imported via the submodule path so the '../src/lib' barrel mock never masks it.
  it('ALL_DRIVES enables shared-drive support', async () => {
    const { ALL_DRIVES } = await import('../src/lib/shared-drive');
    expect(ALL_DRIVES).toEqual({ supportsAllDrives: true });
  });

  it('ALL_DRIVES_LIST scopes listing across My Drive + all shared drives', async () => {
    const { ALL_DRIVES_LIST } = await import('../src/lib/shared-drive');
    expect(ALL_DRIVES_LIST).toEqual({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    });
  });
});

describe('shared drive params reach the Drive API boundary', () => {
  it('list-files sends the EXACT params to files.list (no extra/changed field)', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { listFiles } = await import('../src/tools/list-files');
    await listFiles.handler({ folderId: 'shared-folder-id' }, ctx);

    // toEqual on the whole payload (not field-by-field) so an extra or changed
    // param is caught, per TESTING-QUALITY §4 (assert the exact payload).
    expect(calls.list).toEqual({
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
      q: "trashed=false and 'shared-folder-id' in parents",
      pageSize: 10,
      fields:
        'files(id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink, driveId), nextPageToken, incompleteSearch',
      orderBy: 'modifiedTime desc',
    });
  });

  it('list-files surfaces incompleteSearch only when the API reports it', async () => {
    const { drive, calls } = makeDrive();
    drive.files.list = mock(async (params: any) => {
      calls.list = params;
      return { data: { files: [], incompleteSearch: true } };
    });
    installLibMock(drive);
    const { listFiles } = await import('../src/tools/list-files');
    const res = (await listFiles.handler({}, ctx)) as { incompleteSearch?: boolean };
    expect(res.incompleteSearch).toBe(true);
  });

  it('search-files sends the full shared-drive list param set', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { searchFiles } = await import('../src/tools/search-files');
    await searchFiles.handler({ searchTerm: 'budget' }, ctx);

    expect(calls.list.supportsAllDrives).toBe(true);
    expect(calls.list.includeItemsFromAllDrives).toBe(true);
    expect(calls.list.corpora).toBe('allDrives');
  });

  it('get-file sends supportsAllDrives', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { getFile } = await import('../src/tools/get-file');
    await getFile.handler({ fileId: 'f1' }, ctx);
    expect(calls.get).toEqual({
      supportsAllDrives: true,
      fileId: 'f1',
      fields:
        'id, name, mimeType, size, createdTime, modifiedTime, parents, webViewLink, webContentLink, description, owners, driveId',
    });
  });

  it('create-folder sends supportsAllDrives on files.create', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { createFolder } = await import('../src/tools/create-folder');
    await createFolder.handler({ name: 'New', parentFolderId: 'shared-folder' }, ctx);
    expect(calls.create.supportsAllDrives).toBe(true);
  });

  it('copy-file sends supportsAllDrives on files.copy', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { copyFile } = await import('../src/tools/copy-file');
    await copyFile.handler({ fileId: 'f1' }, ctx);
    expect(calls.copy.supportsAllDrives).toBe(true);
  });

  it('delete-file sends supportsAllDrives on files.delete', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { deleteFile } = await import('../src/tools/delete-file');
    await deleteFile.handler({ fileId: 'f1' }, ctx);
    expect(calls.delete.supportsAllDrives).toBe(true);
  });

  it('move-file sends supportsAllDrives on BOTH files.get and files.update', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { moveFile } = await import('../src/tools/move-file');
    await moveFile.handler({ fileId: 'f1', newParentId: 'p2' }, ctx);
    expect(calls.get.supportsAllDrives).toBe(true);
    expect(calls.update.supportsAllDrives).toBe(true);
  });

  it('share-file sends supportsAllDrives on permissions.create', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { shareFile } = await import('../src/tools/share-file');
    await shareFile.handler({ fileId: 'f1', emailAddress: 'a@b.com' }, ctx);
    expect(calls.permCreate.supportsAllDrives).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural guard: make the bug impossible by construction. Every gated
// call-site must carry the ...ALL_DRIVES / ...ALL_DRIVES_LIST spread within its
// argument object. files.export / comments.* / replies.* are intentionally
// excluded (they operate by fileId and do not accept the param).
// ---------------------------------------------------------------------------
describe('structural guard: no gated Drive call without shared-drive params', () => {
  const GATED =
    /clients\.drive\.(?:files\.(?:get|list|create|update|copy|delete)|permissions\.(?:create|update|delete|get|list))\b/g;

  const sources = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, content: readFileSync(join(TOOLS_DIR, f), 'utf-8') }));

  it('every gated call-site spreads ALL_DRIVES within its arguments', () => {
    const offenders: string[] = [];
    let total = 0;
    for (const { file, content } of sources) {
      for (const match of content.matchAll(GATED)) {
        total++;
        const window = content.slice(match.index, (match.index ?? 0) + 500);
        if (!window.includes('...ALL_DRIVES')) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(total).toBeGreaterThan(0); // the regex actually matches something
    expect(offenders).toEqual([]);
  });

  it('files.export / comments / replies are NOT given shared-drive params', () => {
    // Guards against a careless future edit that passes an unsupported param.
    const BYID = /clients\.drive\.(?:files\.export|comments\.\w+|replies\.\w+)\b/g;
    const offenders: string[] = [];
    for (const { file, content } of sources) {
      for (const match of content.matchAll(BYID)) {
        const window = content.slice(match.index, (match.index ?? 0) + 300);
        if (window.includes('...ALL_DRIVES')) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
