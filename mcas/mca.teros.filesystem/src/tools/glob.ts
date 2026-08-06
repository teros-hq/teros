import type { ToolConfig } from '@teros/mca-sdk';
import { runGlob } from '../lib/glob-runner';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { decodeCursor, paginate, wrap } from '../lib/structured';

export const glob: ToolConfig = {
  description:
    'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.{ts,tsx}"). Results sorted by mtime (most recently modified first). Honors `ignore` patterns and `respectGitignore`. Use `grep` for content search and `list` for flat directory listing.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Base directory (default: workspace root)' },
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
    const basePath = (args.path as string | undefined) ?? (guard.roots[0] ?? process.cwd());
    const canonical = guard.resolve(basePath);

    const limit = Math.min(
      typeof args.limit === 'number' ? Math.max(1, args.limit) : LIMITS.DEFAULT_LIST_LIMIT,
      LIMITS.MAX_GLOB_RESULTS,
    );
    const offset = decodeCursor(args.cursor as string | undefined);

    const result = await runGlob({
      pattern,
      cwd: canonical,
      respectGitignore: Boolean(args.respectGitignore),
      userIgnore: Array.isArray(args.ignore) ? (args.ignore as string[]) : undefined,
      includeDirs: Boolean(args.includeDirs),
      dot: Boolean(args.dot),
      limit: LIMITS.MAX_GLOB_RESULTS,
    });

    const { page, nextCursor } = paginate(result.entries, offset, limit);

    return wrap(
      {
        pattern,
        path: canonical,
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
