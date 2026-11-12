/**
 * Smoke tests for tool handlers. Hits the real implementations end-to-end
 * on a temp workspace. Does not start an HTTP server — calls handlers directly.
 *
 * In the ctx.volume architecture, tests provide a mock ctx.volume that
 * backs onto a local temp directory. Paths use the canonical /workspace
 * prefix (stripped by path-safety to volume-relative before hitting the mock).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendFile } from '../../src/tools/append-file';
import { copyFile } from '../../src/tools/copy-file';
import { deleteFile } from '../../src/tools/delete-file';
import { editFile } from '../../src/tools/edit-file';
import { findFiles } from '../../src/tools/find-files';
import { searchInFiles } from '../../src/tools/search-in-files';
import { hashFile } from '../../src/tools/hash-file';
import { listFiles } from '../../src/tools/list-files';
import { listRoots } from '../../src/tools/list-roots';
import { createDirectory } from '../../src/tools/create-directory';
import { moveFile } from '../../src/tools/move-file';
import { patchFile } from '../../src/tools/patch-file';
import { readFile } from '../../src/tools/read-file';
import { readFiles } from '../../src/tools/read-files';
import { readBinary } from '../../src/tools/read-binary';
import { fileInfo } from '../../src/tools/file-info';
import { treeView } from '../../src/tools/tree-view';
import { createFile } from '../../src/tools/create-file';
import { resetDefaultGuard } from '../../src/lib/path-safety';
import { clearSession } from '../../src/lib/session';
import type { VolumeStorage, VolumeEntry, VolumeStat } from '@teros/mca-sdk';

const WS = join('/tmp', `fs-v2-tools-${Date.now()}`);

/**
 * Mock VolumeStorage that backs onto a local directory.
 * This simulates the ctx.volume API using native fs against a temp dir.
 */
function createMockVolume(rootDir: string): VolumeStorage {
  const toLocal = (volPath: string) => join(rootDir, volPath);
  const fromLocal = (localPath: string) => {
    const rel = localPath.startsWith(rootDir) ? localPath.slice(rootDir.length) : localPath;
    return rel || '/';
  };

  return {
    async list(path: string): Promise<VolumeEntry[]> {
      const local = toLocal(path);
      const entries = readdirSync(local, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' as const : 'file' as const,
        size: e.isFile() ? statSync(join(local, e.name)).size : undefined,
      }));
    },
    async read(path: string): Promise<string | null> {
      const local = toLocal(path);
      try {
        const data = readFileSync(local);
        return data.toString('base64');
      } catch {
        return null;
      }
    },
    async write(path: string, data: string): Promise<void> {
      const local = toLocal(path);
      const dir = local.substring(0, local.lastIndexOf('/'));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(local, Buffer.from(data, 'base64'));
    },
    async delete(path: string, options?: { recursive?: boolean }): Promise<void> {
      const local = toLocal(path);
      if (!existsSync(local)) return;
      rmSync(local, { recursive: options?.recursive ?? false, force: true });
    },
    async stat(path: string): Promise<VolumeStat | null> {
      const local = toLocal(path);
      try {
        const st = statSync(local);
        return {
          size: st.size,
          isDirectory: st.isDirectory(),
          modifiedAt: st.mtime.toISOString(),
        };
      } catch {
        return null;
      }
    },
    async mkdir(path: string): Promise<void> {
      const local = toLocal(path);
      mkdirSync(local, { recursive: true });
    },
    getTempPath(filename: string): string {
      return `/tmp/test/${filename}`;
    },
  };
}

const mockCtx = { volume: createMockVolume(WS) } as any;

async function call<T>(tool: { handler: (args: any, ctx: any) => any }, args: Record<string, unknown>): Promise<T> {
  return (await tool.handler(args, mockCtx)) as T;
}

interface Wrapped<T = unknown> {
  structuredContent: T;
  content: Array<{ type: string; text: string }>;
  nextCursor?: string;
}

beforeAll(() => {
  mkdirSync(WS, { recursive: true });
  // glob and grep still use native fs — they need to know the local mount point
  process.env.MCA_VOLUME_MOUNT_PATH = WS;
  resetDefaultGuard();
});

afterAll(() => {
  delete process.env.MCA_VOLUME_MOUNT_PATH;
  resetDefaultGuard();
  if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
});

beforeEach(() => {
  clearSession();
  // rebuild workspace content
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, 'a.txt'), ['line1', 'line2', 'line3'].join('\n'));
  writeFileSync(join(WS, 'b.md'), '# Hello\n\nWorld\n');
  mkdirSync(join(WS, 'sub'));
  writeFileSync(join(WS, 'sub', 'c.ts'), 'export const x = 42;\n');
});

describe('read-file / read-files / file-info', () => {
  it('read-file returns cat -n content + metadata', async () => {
    const res = await call<Wrapped<any>>(readFile, { filePath: '/workspace/a.txt' });
    expect(res.structuredContent.totalLines).toBe(3);
    expect(res.structuredContent.content).toContain('00001|');
    expect(res.structuredContent.kind).toBe('text');
  });

  it('read-file supports head / tail', async () => {
    const head = await call<Wrapped<any>>(readFile, { filePath: '/workspace/a.txt', head: 1 });
    expect(head.structuredContent.displayedLines).toBe(1);
    const tail = await call<Wrapped<any>>(readFile, { filePath: '/workspace/a.txt', tail: 1 });
    expect(tail.structuredContent.offset).toBe(2);
  });

  it('read-files returns one entry per path with ok/error', async () => {
    const res = await call<Wrapped<any>>(readFiles, {
      paths: ['/workspace/a.txt', '/workspace/does-not-exist.txt'],
    });
    expect(res.structuredContent.ok).toBe(1);
    expect(res.structuredContent.failed).toBe(1);
  });

  it('file-info returns metadata without reading', async () => {
    const res = await call<Wrapped<any>>(fileInfo, { path: '/workspace/a.txt' });
    expect(res.structuredContent.exists).toBe(true);
    expect(res.structuredContent.type).toBe('file');
  });

  it('file-info returns exists=false for missing paths', async () => {
    const res = await call<Wrapped<any>>(fileInfo, { path: '/workspace/missing.txt' });
    expect(res.structuredContent.exists).toBe(false);
  });
});

describe('create-file / append-file safety', () => {
  it('create-file allows creating new files', async () => {
    const res = await call<Wrapped<any>>(createFile, { filePath: '/workspace/new.txt', content: 'hi' });
    expect(res.structuredContent.created).toBe(true);
  });

  it('create-file blocks overwriting without prior read', async () => {
    await expect(
      call(createFile, { filePath: '/workspace/a.txt', content: 'overwrite' }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('create-file allows overwrite after read', async () => {
    await call(readFile, { filePath: '/workspace/a.txt' });
    const res = await call<Wrapped<any>>(createFile, {
      filePath: '/workspace/a.txt',
      content: 'new',
    });
    expect(res.structuredContent.created).toBe(false);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toBe('new');
  });

  it('append-file does not require prior read', async () => {
    const res = await call<Wrapped<any>>(appendFile, {
      filePath: '/workspace/a.txt',
      content: '\nline4',
    });
    expect(res.structuredContent.bytesAppended).toBeGreaterThan(0);
  });
});

describe('edit-file / patch-file', () => {
  it('edit-file replaces an exact unique occurrence', async () => {
    const res = await call<Wrapped<any>>(editFile, {
      filePath: '/workspace/a.txt',
      oldString: 'line2',
      newString: 'LINE_TWO',
    });
    expect(res.structuredContent.replacements).toBe(1);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toContain('LINE_TWO');
  });

  it('edit-file without replaceAll errors when ambiguous', async () => {
    writeFileSync(join(WS, 'dup.txt'), 'x\nx\n');
    await expect(
      call(editFile, { filePath: '/workspace/dup.txt', oldString: 'x', newString: 'y' }),
    ).rejects.toThrow(/appears 2 times/);
  });

  it('patch-file applies a unified diff', async () => {
    const uniDiff = `--- a.txt
+++ a.txt
@@ -1,3 +1,3 @@
 line1
-line2
+LINE_TWO
 line3
`;
    const res = await call<Wrapped<any>>(patchFile, {
      filePath: '/workspace/a.txt',
      unifiedDiff: uniDiff,
    });
    expect(res.structuredContent.applied).toBe(true);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toContain('LINE_TWO');
  });
});

describe('list-files / tree-view', () => {
  it('list-files respects depth + sorts dirs first', async () => {
    const res = await call<Wrapped<any>>(listFiles, { path: '/workspace', depth: 0 });
    const entries = res.structuredContent.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].type).toBe('directory');
  });

  it('list-files honors user ignore patterns', async () => {
    const res = await call<Wrapped<any>>(listFiles, { path: '/workspace', depth: 1, ignore: ['**/*.md'] });
    const names = res.structuredContent.entries.map((e: any) => e.name);
    expect(names).not.toContain('b.md');
  });

  it('tree-view returns hierarchical JSON', async () => {
    const res = await call<Wrapped<any>>(treeView, { path: '/workspace', depth: 2 });
    expect(res.structuredContent.tree.children.length).toBeGreaterThan(0);
  });
});

describe('grep', () => {
  it('search-in-files content mode returns matches with context', async () => {
    const res = await call<Wrapped<any>>(searchInFiles, {
      pattern: 'line2',
      path: '/workspace',
      output_mode: 'content',
      contextBefore: 1,
      contextAfter: 1,
    });
    expect(res.structuredContent.totalMatches).toBeGreaterThan(0);
    expect(res.structuredContent.matches[0].lineNumber).toBeGreaterThan(0);
  });

  it('search-in-files files mode returns one entry per file', async () => {
    const res = await call<Wrapped<any>>(searchInFiles, {
      pattern: 'line',
      path: '/workspace',
      output_mode: 'files',
    });
    expect(res.structuredContent.mode).toBe('files');
  });

  it('search-in-files count mode returns only totals', async () => {
    const res = await call<Wrapped<any>>(searchInFiles, {
      pattern: 'line',
      path: '/workspace',
      output_mode: 'count',
    });
    expect(res.structuredContent.totalMatches).toBeGreaterThan(0);
    expect(res.structuredContent.matches).toBeUndefined();
  });
});

describe('delete / copy / move / mkdir', () => {
  it('create-directory creates directories idempotently', async () => {
    const res1 = await call<Wrapped<any>>(createDirectory, { path: '/workspace/newdir' });
    expect(res1.structuredContent.created).toBe(true);
    const res2 = await call<Wrapped<any>>(createDirectory, { path: '/workspace/newdir' });
    expect(res2.structuredContent.created).toBe(false);
  });

  it('copy supports directories with recursive', async () => {
    const res = await call<Wrapped<any>>(copyFile, {
      source: '/workspace/sub',
      destination: '/workspace/sub2',
      recursive: true,
    });
    expect(res.structuredContent.type).toBe('directory');
    expect(existsSync(join(WS, 'sub2', 'c.ts'))).toBe(true);
  });

  it('move renames files', async () => {
    await call(moveFile, { source: '/workspace/a.txt', destination: '/workspace/a-renamed.txt' });
    expect(existsSync(join(WS, 'a.txt'))).toBe(false);
    expect(existsSync(join(WS, 'a-renamed.txt'))).toBe(true);
  });

  it('delete-file removes files and dirs', async () => {
    await call(deleteFile, { path: '/workspace/a.txt' });
    expect(existsSync(join(WS, 'a.txt'))).toBe(false);

    await call(deleteFile, { path: '/workspace/sub', recursive: true });
    expect(existsSync(join(WS, 'sub'))).toBe(false);
  });

  it('delete is idempotent (existed=false on missing)', async () => {
    const res = await call<Wrapped<any>>(deleteFile, { path: '/workspace/missing.txt' });
    expect(res.structuredContent.existed).toBe(false);
  });
});

describe('structured content shape (MCP spec criterion 15)', () => {
  it('every successful tool returns {content, structuredContent}', async () => {
    const res = await call<Wrapped<any>>(fileInfo, { path: '/workspace' });
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0]?.type).toBe('text');
    expect(res.structuredContent).toBeDefined();
  });
});

describe('list-roots / read-media / hash (v2.1 additions)', () => {
  it('list-roots returns `/workspace` (the volume root, user-facing)', async () => {
    const res = await call<Wrapped<any>>(listRoots, {});
    expect(res.structuredContent.count).toBe(1);
    expect(res.structuredContent.roots[0].path).toBe('/workspace');
    expect(res.structuredContent.roots[0].exists).toBe(true);
    expect(res.structuredContent.roots[0].type).toBe('directory');
  });

  it('read-binary returns base64 + detected mime for a PNG fixture', async () => {
    // Minimal valid PNG (8-byte signature + IHDR + IEND chunks)
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    writeFileSync(join(WS, 'fixture.png'), png);

    const res = await call<Wrapped<any>>(readBinary, { filePath: '/workspace/fixture.png' });
    expect(res.structuredContent.mimeType).toBe('image/png');
    expect(res.structuredContent.size).toBe(png.length);
    expect(typeof res.structuredContent.base64).toBe('string');
    expect(res.structuredContent.base64.length).toBeGreaterThan(0);
  });

  it('hash sha256 matches a precomputed value', async () => {
    writeFileSync(join(WS, 'hashable.txt'), 'hello\n');
    // sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
    const res = await call<Wrapped<any>>(hashFile, { filePath: '/workspace/hashable.txt' });
    expect(res.structuredContent.algorithm).toBe('sha256');
    expect(res.structuredContent.hash).toBe(
      '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
    );
    expect(res.structuredContent.size).toBe(6);
  });

  it('hash rejects weak algorithms (md5, sha1)', async () => {
    writeFileSync(join(WS, 'hashable.txt'), 'hello\n');
    await expect(call<Wrapped<any>>(hashFile, { filePath: '/workspace/hashable.txt', algorithm: 'md5' })).rejects.toThrow();
    await expect(call<Wrapped<any>>(hashFile, { filePath: '/workspace/hashable.txt', algorithm: 'sha1' })).rejects.toThrow();
  });

  it('stat now exposes mimeType for regular files when detectable', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    writeFileSync(join(WS, 'mime-probe.png'), png);
    const res = await call<Wrapped<any>>(fileInfo, { path: '/workspace/mime-probe.png' });
    expect(res.structuredContent.mimeType).toBe('image/png');
  });

  it('stat always returns the mimeType field for regular files (null when not detectable)', async () => {
    // Plain text has no magic bytes — file-type returns undetected → field MUST still be present as null.
    const res = await call<Wrapped<any>>(fileInfo, { path: '/workspace/a.txt' });
    expect(Object.prototype.hasOwnProperty.call(res.structuredContent, 'mimeType')).toBe(true);
    expect(res.structuredContent.mimeType).toBeNull();
  });

  it('read reports totalLines: 0 for an empty file', async () => {
    writeFileSync(join(WS, 'empty.txt'), '');
    const res = await call<Wrapped<any>>(readFile, { filePath: '/workspace/empty.txt' });
    expect(res.structuredContent.totalLines).toBe(0);
    expect(res.structuredContent.size).toBe(0);
  });
});

describe('edit / patch dryRun', () => {
  it('edit with dryRun=true returns diff but does not modify the file', async () => {
    const before = readFileSync(join(WS, 'a.txt'), 'utf-8');
    const res = await call<Wrapped<any>>(editFile, {
      filePath: '/workspace/a.txt',
      oldString: 'line2',
      newString: 'LINE TWO',
      dryRun: true,
    });
    expect(res.structuredContent.dryRun).toBe(true);
    expect(res.structuredContent.replacements).toBe(1);
    const after = readFileSync(join(WS, 'a.txt'), 'utf-8');
    expect(after).toBe(before);
  });

  it('patch with dryRun=true returns applied=true but file unchanged', async () => {
    writeFileSync(join(WS, 'patchable.txt'), 'foo\nbar\n');
    const before = readFileSync(join(WS, 'patchable.txt'), 'utf-8');
    const diff = [
      `--- a/patchable.txt`,
      `+++ b/patchable.txt`,
      `@@ -1,2 +1,2 @@`,
      `-foo`,
      `+FOO`,
      ` bar`,
      ``,
    ].join('\n');
    const res = await call<Wrapped<any>>(patchFile, {
      filePath: '/workspace/patchable.txt',
      unifiedDiff: diff,
      dryRun: true,
    });
    expect(res.structuredContent.applied).toBe(true);
    expect(res.structuredContent.dryRun).toBe(true);
    const after = readFileSync(join(WS, 'patchable.txt'), 'utf-8');
    expect(after).toBe(before);
  });
});

describe('grep type filter (v2.1)', () => {
  it('grep with type=md only matches .md files', async () => {
    writeFileSync(join(WS, 'doc.md'), 'NEEDLE in md\n');
    writeFileSync(join(WS, 'code.ts'), 'NEEDLE in ts\n');
    const res = await call<Wrapped<any>>(searchInFiles, {
      pattern: 'NEEDLE',
      path: '/workspace',
      output_mode: 'files',
      type: 'md',
    });
    const files = res.structuredContent.files as Array<{ file: string }>;
    expect(files.length).toBe(1);
    expect(files[0]?.file.endsWith('.md')).toBe(true);
  });
});
