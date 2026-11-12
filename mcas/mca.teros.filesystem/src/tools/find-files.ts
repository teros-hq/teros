// @fixme nira - 2026.09.26: find-files uses tinyglobby which requires real filesystem access (cwd-based).
// Cannot be migrated to ctx.volume without reimplementing glob matching in-memory via ctx.volume.list.
// Left with native fs temporarily — the local root is resolved by resolveLocalRoot() (container mount,
// owner workspace hostPath via MCA_WORKSPACE_PATH, or host root for the admin role). When the MCA runs
// without a local mount, find-files will need to be reimplemented using ctx.volume.list + in-memory
// pattern matching.
import type { ToolConfig } from '@teros/mca-sdk';
import { runGlob } from '../lib/glob-runner';
import { LIMITS } from '../lib/limits';
import { resolveLocalRoot } from '../lib/local-root';
import { defaultRootPath, getDefaultGuard, toUserPath } from '../lib/path-safety';
import { decodeCursor, paginate, wrap } from '../lib/structured';

export const findFiles: ToolConfig = {
  description:
    'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.{ts,tsx}"). Results sorted by mtime (most recently modified first). Honors `ignore` patterns and `respectGitignore`. Use `search-in-files` for content search and `list-files` for flat directory listing.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Base directory (default: `/workspace`, the volume root)' },
      respectGitignore: { type: 'boolean' },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra ignore patterns (gitignore syntax)',
      },
      includeDirs: { type: 'boolean', description: 'Include directories in results' },
      dot: { type: 'boolean', description: 'Match dotfiles (default false)' },
      limit: {
        type: 'number',
        description: `Max results (default ${LIMITS.DEFAULT_LIST_LIMIT}, max ${LIMITS.MAX_GLOB_RESULTS})`,
      },
      cursor: { type: 'string' },
    },
    required: ['pattern'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (args) => {
    const pattern = args.pattern as string;
    if (typeof pattern !== 'string' || !pattern) {
      throw new Error('pattern must be a non-empty string');
    }

    const guard = getDefaultGuard();
    const basePath = (args.path as string | undefined) ?? defaultRootPath();
    const volumePath = guard.resolve(basePath);

    // @fixme: glob-runner uses tinyglobby which needs a real filesystem cwd.
    // We map the volume-relative path to the local root for now. resolveLocalRoot()
    // prefers the container mount, then the owner workspace's real volume hostPath
    // (MCA_WORKSPACE_PATH, stdio mode) — never the global host symlink of another
    // workspace. Admin role: host root '/'.
    const localRoot = resolveLocalRoot();
    const localCwd = volumePath === '/' ? localRoot : `${localRoot}${volumePath}`;

    const limit = Math.min(
      typeof args.limit === 'number' ? Math.max(1, args.limit) : LIMITS.DEFAULT_LIST_LIMIT,
      LIMITS.MAX_GLOB_RESULTS,
    );
    const offset = decodeCursor(args.cursor as string | undefined);

    const result = await runGlob({
      pattern,
      cwd: localCwd,
      respectGitignore: Boolean(args.respectGitignore),
      userIgnore: Array.isArray(args.ignore) ? (args.ignore as string[]) : undefined,
      includeDirs: Boolean(args.includeDirs),
      dot: Boolean(args.dot),
      limit: LIMITS.MAX_GLOB_RESULTS,
    });

    // Convert local paths back to user-facing paths (/workspace-prefixed in the
    // workspace role; host paths as-is in the admin role)
    const volumeEntries = result.entries.map((e) => ({
      ...e,
      path: e.path.startsWith(localRoot) ? toUserPath(e.path.slice(localRoot.length) || '/') : e.path,
    }));

    const { page, nextCursor } = paginate(volumeEntries, offset, limit);

    return wrap(
      {
        pattern,
        path: toUserPath(volumePath),
        totalFound: result.totalFound,
        truncated: result.truncated,
        returned: page.length,
        offset,
        entries: page,
      },
      nextCursor,
    );
  },
};
