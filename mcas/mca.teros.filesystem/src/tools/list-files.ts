import type { ToolConfig } from '@teros/mca-sdk';
import { basename } from 'node:path';
import { detectFileKind, humanizeBytes } from '../lib/formatters';
import { buildIgnoreFilter } from '../lib/ignore';
import { LIMITS } from '../lib/limits';
import { defaultRootPath, getDefaultGuard, toUserPath } from '../lib/path-safety';
import { decodeCursor, paginate, wrap } from '../lib/structured';

interface ListItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  sizeHuman: string;
  mtime: string;
  kind?: string;
  depth: number;
}

export const listFiles: ToolConfig = {
  description:
    'List directory entries with metadata (name, type, size, mtime, kind). Optionally recursive via `depth`. Honors `ignore` patterns (glob-style) and `respectGitignore`. Paginates with `limit` + `cursor`. For a hierarchical view use `tree-view`; for pattern-based search use `find-files`.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default: `/workspace`, the volume root)' },
      depth: {
        type: 'number',
        description: `Max recursion depth (0 = current dir only, default 0, max ${LIMITS.MAX_TREE_DEPTH})`,
      },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra ignore patterns (gitignore syntax)',
      },
      respectGitignore: {
        type: 'boolean',
        description: 'If true, honor .gitignore from the volume root',
      },
      limit: {
        type: 'number',
        description: `Max entries to return (default ${LIMITS.DEFAULT_LIST_LIMIT}, max ${LIMITS.MAX_LIST_LIMIT})`,
      },
      cursor: { type: 'string', description: 'Pagination cursor from previous response' },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args, ctx) => {
    const guard = getDefaultGuard();
    const rawPath = (args.path as string | undefined) ?? defaultRootPath();
    const dirPath = guard.resolve(rawPath);

    const statResult = await ctx.volume.stat(dirPath);
    if (!statResult) {
      throw new Error(`Path not found: ${rawPath}`);
    }
    if (!statResult.isDirectory) {
      throw new Error(`Path is not a directory: ${rawPath}`);
    }

    const depth = Math.min(
      typeof args.depth === 'number' ? Math.max(0, args.depth) : 0,
      LIMITS.MAX_TREE_DEPTH,
    );
    const limit = Math.min(
      typeof args.limit === 'number' ? Math.max(1, args.limit) : LIMITS.DEFAULT_LIST_LIMIT,
      LIMITS.MAX_LIST_LIMIT,
    );
    const offset = decodeCursor(args.cursor as string | undefined);
    const userIgnore = Array.isArray(args.ignore) ? (args.ignore as string[]) : undefined;
    const respectGitignore = Boolean(args.respectGitignore);

    // Read .gitignore if respectGitignore is requested
    let gitignoreContent: string | undefined;
    if (respectGitignore) {
      const giData = await ctx.volume.read('/.gitignore');
      if (giData) {
        gitignoreContent = Buffer.from(giData, 'base64').toString('utf-8');
      }
    }

    const filter = buildIgnoreFilter({
      userPatterns: userIgnore,
      respectGitignore,
      gitignoreContent,
    });

    const all: ListItem[] = [];
    async function walk(dir: string, currentDepth: number) {
      const entries = await ctx.volume.list(dir);
      for (const entry of entries) {
        const fullPath = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
        // internal volume path; converted to user-facing at output time
        const rel = fullPath.slice(1); // relative to volume root
        if (filter.ignores(rel)) continue;
        const type: ListItem['type'] = entry.type === 'directory' ? 'directory' : 'file';
        const item: ListItem = {
          name: entry.name,
          path: toUserPath(fullPath),
          type,
          size: entry.size ?? 0,
          sizeHuman: humanizeBytes(entry.size ?? 0),
          mtime: '',
          depth: currentDepth,
        };
        if (type === 'file') item.kind = detectFileKind(entry.name);
        all.push(item);
        if (type === 'directory' && currentDepth < depth) {
          await walk(fullPath, currentDepth + 1);
        }
      }
    }
    await walk(dirPath, 0);

    all.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const { page, nextCursor } = paginate(all, offset, limit);

    return wrap(
      {
        path: toUserPath(dirPath),
        depth,
        respectGitignore,
        totalEntries: all.length,
        returned: page.length,
        offset,
        entries: page,
      },
      nextCursor,
    );
  },
};
