/**
 * Smoke tests for tool handlers. Hits the real implementations end-to-end
 * on a temp workspace. Does not start an HTTP server — calls handlers directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { append } from '../../src/tools/append';
import { copy } from '../../src/tools/copy';
import { deleteTool } from '../../src/tools/delete';
import { edit } from '../../src/tools/edit';
import { glob } from '../../src/tools/glob';
import { grep } from '../../src/tools/grep';
import { hash } from '../../src/tools/hash';
import { list } from '../../src/tools/list';
import { listRoots } from '../../src/tools/list-roots';
import { mkdir } from '../../src/tools/mkdir';
import { move } from '../../src/tools/move';
import { patch } from '../../src/tools/patch';
import { read } from '../../src/tools/read';
import { readBatch } from '../../src/tools/read-batch';
import { readMedia } from '../../src/tools/read-media';
import { stat } from '../../src/tools/stat';
import { tree } from '../../src/tools/tree';
import { write } from '../../src/tools/write';
import { resetDefaultGuard } from '../../src/lib/path-safety';
import { clearSession } from '../../src/lib/session';

const WS = join(tmpdir(), `fs-v2-tools-${Date.now()}`);
const NOOP_CONTEXT = {} as never;

async function call<T>(tool: { handler: (args: any, ctx: any) => any }, args: Record<string, unknown>): Promise<T> {
  return (await tool.handler(args, NOOP_CONTEXT)) as T;
}

interface Wrapped<T = unknown> {
  structuredContent: T;
  content: Array<{ type: string; text: string }>;
  nextCursor?: string;
}

beforeAll(() => {
  mkdirSync(WS, { recursive: true });
  process.env.MCA_WORKSPACE_PATH = WS;
  resetDefaultGuard();
});

afterAll(() => {
  delete process.env.MCA_WORKSPACE_PATH;
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

describe('read / read-batch / stat', () => {
  it('read returns cat -n content + metadata', async () => {
    const res = await call<Wrapped<any>>(read, { filePath: join(WS, 'a.txt') });
    expect(res.structuredContent.totalLines).toBe(3);
    expect(res.structuredContent.content).toContain('00001|');
    expect(res.structuredContent.kind).toBe('text');
  });

  it('read supports head / tail', async () => {
    const head = await call<Wrapped<any>>(read, { filePath: join(WS, 'a.txt'), head: 1 });
    expect(head.structuredContent.displayedLines).toBe(1);
    const tail = await call<Wrapped<any>>(read, { filePath: join(WS, 'a.txt'), tail: 1 });
    expect(tail.structuredContent.offset).toBe(2);
  });

  it('read-batch returns one entry per path with ok/error', async () => {
    const res = await call<Wrapped<any>>(readBatch, {
      paths: [join(WS, 'a.txt'), join(WS, 'does-not-exist.txt')],
    });
    expect(res.structuredContent.ok).toBe(1);
    expect(res.structuredContent.failed).toBe(1);
  });

  it('stat returns metadata without reading', async () => {
    const res = await call<Wrapped<any>>(stat, { path: join(WS, 'a.txt') });
    expect(res.structuredContent.exists).toBe(true);
    expect(res.structuredContent.type).toBe('file');
  });

  it('stat returns exists=false for missing paths', async () => {
    const res = await call<Wrapped<any>>(stat, { path: join(WS, 'missing.txt') });
    expect(res.structuredContent.exists).toBe(false);
  });
});

describe('write / append safety', () => {
  it('write allows creating new files', async () => {
    const res = await call<Wrapped<any>>(write, { filePath: join(WS, 'new.txt'), content: 'hi' });
    expect(res.structuredContent.created).toBe(true);
  });

  it('write blocks overwriting without prior read', async () => {
    await expect(
      call(write, { filePath: join(WS, 'a.txt'), content: 'overwrite' }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('write allows overwrite after read', async () => {
    await call(read, { filePath: join(WS, 'a.txt') });
    const res = await call<Wrapped<any>>(write, {
      filePath: join(WS, 'a.txt'),
      content: 'new',
    });
    expect(res.structuredContent.created).toBe(false);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toBe('new');
  });

  it('append does not require prior read', async () => {
    const res = await call<Wrapped<any>>(append, {
      filePath: join(WS, 'a.txt'),
      content: '\nline4',
    });
    expect(res.structuredContent.bytesAppended).toBeGreaterThan(0);
  });
});

describe('edit / patch', () => {
  it('edit replaces an exact unique occurrence', async () => {
    const res = await call<Wrapped<any>>(edit, {
      filePath: join(WS, 'a.txt'),
      oldString: 'line2',
      newString: 'LINE_TWO',
    });
    expect(res.structuredContent.replacements).toBe(1);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toContain('LINE_TWO');
  });

  it('edit without replaceAll errors when ambiguous', async () => {
    writeFileSync(join(WS, 'dup.txt'), 'x\nx\n');
    await expect(
      call(edit, { filePath: join(WS, 'dup.txt'), oldString: 'x', newString: 'y' }),
    ).rejects.toThrow(/appears 2 times/);
  });

  it('patch applies a unified diff', async () => {
    const uniDiff = `--- a.txt
+++ a.txt
@@ -1,3 +1,3 @@
 line1
-line2
+LINE_TWO
 line3
`;
    const res = await call<Wrapped<any>>(patch, {
      filePath: join(WS, 'a.txt'),
      unifiedDiff: uniDiff,
    });
    expect(res.structuredContent.applied).toBe(true);
    expect(readFileSync(join(WS, 'a.txt'), 'utf-8')).toContain('LINE_TWO');
  });
});

describe('list / tree / glob', () => {
  it('list respects depth + sorts dirs first', async () => {
    const res = await call<Wrapped<any>>(list, { path: WS, depth: 0 });
    const entries = res.structuredContent.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].type).toBe('directory');
  });

  it('list honors user ignore patterns', async () => {
    const res = await call<Wrapped<any>>(list, { path: WS, depth: 1, ignore: ['**/*.md'] });
    const names = res.structuredContent.entries.map((e: any) => e.name);
    expect(names).not.toContain('b.md');
  });

  it('tree returns hierarchical JSON', async () => {
    const res = await call<Wrapped<any>>(tree, { path: WS, depth: 2 });
    expect(res.structuredContent.tree.children.length).toBeGreaterThan(0);
  });

  it('glob returns files sorted by mtime', async () => {
    const res = await call<Wrapped<any>>(glob, { pattern: '**/*.txt', path: WS });
    expect(res.structuredContent.totalFound).toBeGreaterThan(0);
  });
});

describe('grep', () => {
  it('grep content mode returns matches with context', async () => {
    const res = await call<Wrapped<any>>(grep, {
      pattern: 'line2',
      path: WS,
      output_mode: 'content',
      contextBefore: 1,
      contextAfter: 1,
    });
    expect(res.structuredContent.totalMatches).toBeGreaterThan(0);
    expect(res.structuredContent.matches[0].lineNumber).toBeGreaterThan(0);
  });

  it('grep files mode returns one entry per file', async () => {
    const res = await call<Wrapped<any>>(grep, {
      pattern: 'line',
      path: WS,
      output_mode: 'files',
    });
    expect(res.structuredContent.mode).toBe('files');
  });

  it('grep count mode returns only totals', async () => {
    const res = await call<Wrapped<any>>(grep, {
      pattern: 'line',
      path: WS,
      output_mode: 'count',
    });
    expect(res.structuredContent.totalMatches).toBeGreaterThan(0);
    expect(res.structuredContent.matches).toBeUndefined();
  });
});

describe('delete / copy / move / mkdir', () => {
  it('mkdir creates directories idempotently', async () => {
    const res1 = await call<Wrapped<any>>(mkdir, { path: join(WS, 'newdir') });
    expect(res1.structuredContent.created).toBe(true);
    const res2 = await call<Wrapped<any>>(mkdir, { path: join(WS, 'newdir') });
    expect(res2.structuredContent.created).toBe(false);
  });

  it('copy supports directories with recursive', async () => {
    const res = await call<Wrapped<any>>(copy, {
      source: join(WS, 'sub'),
      destination: join(WS, 'sub2'),
      recursive: true,
    });
    expect(res.structuredContent.type).toBe('directory');
    expect(existsSync(join(WS, 'sub2', 'c.ts'))).toBe(true);
  });

  it('move renames files', async () => {
    await call(move, { source: join(WS, 'a.txt'), destination: join(WS, 'a-renamed.txt') });
    expect(existsSync(join(WS, 'a.txt'))).toBe(false);
    expect(existsSync(join(WS, 'a-renamed.txt'))).toBe(true);
  });

  it('delete removes files and dirs', async () => {
    await call(deleteTool, { path: join(WS, 'a.txt') });
    expect(existsSync(join(WS, 'a.txt'))).toBe(false);

    await call(deleteTool, { path: join(WS, 'sub'), recursive: true });
    expect(existsSync(join(WS, 'sub'))).toBe(false);
  });

  it('delete is idempotent (existed=false on missing)', async () => {
    const res = await call<Wrapped<any>>(deleteTool, { path: join(WS, 'missing.txt') });
    expect(res.structuredContent.existed).toBe(false);
  });
});

describe('structured content shape (MCP spec criterion 15)', () => {
  it('every successful tool returns {content, structuredContent}', async () => {
    const res = await call<Wrapped<any>>(stat, { path: WS });
    expect(Array.isArray(res.content)).toBe(true);
    expect(res.content[0]?.type).toBe('text');
    expect(res.structuredContent).toBeDefined();
  });
});

describe('list-roots / read-media / hash (v2.1 additions)', () => {
  it('list-roots returns the configured workspace roots', async () => {
    const res = await call<Wrapped<any>>(listRoots, {});
    expect(res.structuredContent.count).toBeGreaterThan(0);
    expect(Array.isArray(res.structuredContent.roots)).toBe(true);
    const first = res.structuredContent.roots[0];
    // PathGuard resolves symlinks (e.g. /var -> /private/var on macOS),
    // so compare against the realpath, not the original tmpdir path.
    expect(first.path).toBe(realpathSync(WS));
    expect(first.exists).toBe(true);
    expect(first.type).toBe('directory');
  });

  it('read-media returns base64 + detected mime for a PNG fixture', async () => {
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
    const pngPath = join(WS, 'fixture.png');
    writeFileSync(pngPath, png);

    const res = await call<Wrapped<any>>(readMedia, { filePath: pngPath });
    expect(res.structuredContent.mimeType).toBe('image/png');
    expect(res.structuredContent.size).toBe(png.length);
    expect(typeof res.structuredContent.base64).toBe('string');
    expect(res.structuredContent.base64.length).toBeGreaterThan(0);
  });

  it('hash sha256 matches a precomputed value', async () => {
    const fixture = join(WS, 'hashable.txt');
    writeFileSync(fixture, 'hello\n');
    // sha256("hello\n") = 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
    const res = await call<Wrapped<any>>(hash, { filePath: fixture });
    expect(res.structuredContent.algorithm).toBe('sha256');
    expect(res.structuredContent.hash).toBe(
      '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
    );
    expect(res.structuredContent.size).toBe(6);
  });

  it('hash supports md5 / sha1 alternate algorithms', async () => {
    const fixture = join(WS, 'hashable.txt');
    writeFileSync(fixture, 'hello\n');
    const md5 = await call<Wrapped<any>>(hash, { filePath: fixture, algorithm: 'md5' });
    expect(md5.structuredContent.algorithm).toBe('md5');
    expect(md5.structuredContent.hash).toBe('b1946ac92492d2347c6235b4d2611184');
  });

  it('stat now exposes mimeType for regular files when detectable', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const p = join(WS, 'mime-probe.png');
    writeFileSync(p, png);
    const res = await call<Wrapped<any>>(stat, { path: p });
    expect(res.structuredContent.mimeType).toBe('image/png');
  });

  it('stat always returns the mimeType field for regular files (null when not detectable)', async () => {
    // Plain text has no magic bytes — file-type returns undetected → field MUST still be present as null.
    const res = await call<Wrapped<any>>(stat, { path: join(WS, 'a.txt') });
    expect(Object.prototype.hasOwnProperty.call(res.structuredContent, 'mimeType')).toBe(true);
    expect(res.structuredContent.mimeType).toBeNull();
  });

  it('read reports totalLines: 0 for an empty file', async () => {
    const empty = join(WS, 'empty.txt');
    writeFileSync(empty, '');
    const res = await call<Wrapped<any>>(read, { filePath: empty });
    expect(res.structuredContent.totalLines).toBe(0);
    expect(res.structuredContent.size).toBe(0);
  });
});

describe('edit / patch dryRun', () => {
  it('edit with dryRun=true returns diff but does not modify the file', async () => {
    const before = readFileSync(join(WS, 'a.txt'), 'utf-8');
    const res = await call<Wrapped<any>>(edit, {
      filePath: join(WS, 'a.txt'),
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
    const target = join(WS, 'patchable.txt');
    writeFileSync(target, 'foo\nbar\n');
    const before = readFileSync(target, 'utf-8');
    const diff = [
      `--- a/patchable.txt`,
      `+++ b/patchable.txt`,
      `@@ -1,2 +1,2 @@`,
      `-foo`,
      `+FOO`,
      ` bar`,
      ``,
    ].join('\n');
    const res = await call<Wrapped<any>>(patch, {
      filePath: target,
      unifiedDiff: diff,
      dryRun: true,
    });
    expect(res.structuredContent.applied).toBe(true);
    expect(res.structuredContent.dryRun).toBe(true);
    const after = readFileSync(target, 'utf-8');
    expect(after).toBe(before);
  });
});

describe('grep type filter (v2.1)', () => {
  it('grep with type=md only matches .md files', async () => {
    writeFileSync(join(WS, 'doc.md'), 'NEEDLE in md\n');
    writeFileSync(join(WS, 'code.ts'), 'NEEDLE in ts\n');
    const res = await call<Wrapped<any>>(grep, {
      pattern: 'NEEDLE',
      path: WS,
      output_mode: 'files',
      type: 'md',
    });
    const files = res.structuredContent.files as Array<{ file: string }>;
    expect(files.length).toBe(1);
    expect(files[0]?.file.endsWith('.md')).toBe(true);
  });
});
