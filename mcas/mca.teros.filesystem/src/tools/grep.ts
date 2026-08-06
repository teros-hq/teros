import type { ToolConfig } from '@teros/mca-sdk';
import { LIMITS } from '../lib/limits';
import { getDefaultGuard } from '../lib/path-safety';
import { runRipgrep } from '../lib/ripgrep';
import { decodeCursor, paginate, wrap } from '../lib/structured';

export const grep: ToolConfig = {
  description:
    'Search file contents for a regex pattern using ripgrep. `output_mode` controls the shape: "content" returns {file, line, match, context} objects; "files" returns one entry per matching file with matchCount; "count" returns only totals. Supports context lines (-B/-A), include glob, case insensitive, multiline. Shell-injection safe (args are not interpolated). For finding files by name use `glob`.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (Rust regex syntax via ripgrep)' },
      path: { type: 'string', description: 'Base directory or file (default: workspace root)' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files', 'count'],
        description: 'Result shape (default "content")',
      },
      contextBefore: { type: 'number', description: 'Lines of context before each match' },
      contextAfter: { type: 'number', description: 'Lines of context after each match' },
      include: { type: 'string', description: 'Glob to filter files (e.g. "*.ts", "**/*.md")' },
      type: { type: 'string', description: 'Pre-defined file type filter passed to ripgrep --type (e.g. js, py, rust, ts, go, md). Faster than `include` when you target a known language' },
      caseInsensitive: { type: 'boolean' },
      multiline: { type: 'boolean', description: 'Allow pattern to match across newlines' },
      respectGitignore: { type: 'boolean', description: 'Honor .gitignore (default false)' },
      limit: {
        type: 'number',
        description: `Max matches or files to return (default ${LIMITS.DEFAULT_LIST_LIMIT}, max ${LIMITS.MAX_MATCHES})`,
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

    const outputMode = (args.output_mode as string | undefined) ?? 'content';
    if (!['content', 'files', 'count'].includes(outputMode)) {
      throw new Error(`output_mode must be content|files|count, got "${outputMode}"`);
    }

    const limit = Math.min(
      typeof args.limit === 'number' ? Math.max(1, args.limit) : LIMITS.DEFAULT_LIST_LIMIT,
      LIMITS.MAX_MATCHES,
    );
    const offset = decodeCursor(args.cursor as string | undefined);

    const result = await runRipgrep({
      pattern,
      path: canonical,
      contextBefore:
        typeof args.contextBefore === 'number' ? Math.max(0, args.contextBefore) : 0,
      contextAfter:
        typeof args.contextAfter === 'number' ? Math.max(0, args.contextAfter) : 0,
      include: typeof args.include === 'string' ? args.include : undefined,
      type: typeof args.type === 'string' ? args.type : undefined,
      caseInsensitive: Boolean(args.caseInsensitive),
      multiline: Boolean(args.multiline),
      maxMatches: LIMITS.MAX_MATCHES,
      respectGitignore: Boolean(args.respectGitignore),
    });

    if (outputMode === 'count') {
      return wrap({
        pattern,
        path: canonical,
        mode: 'count',
        totalMatches: result.totalMatches,
        totalFiles: result.totalFiles,
        truncated: result.truncated,
      });
    }

    if (outputMode === 'files') {
      const { page, nextCursor } = paginate(result.files, offset, limit);
      return wrap(
        {
          pattern,
          path: canonical,
          mode: 'files',
          totalFiles: result.totalFiles,
          totalMatches: result.totalMatches,
          truncated: result.truncated,
          returned: page.length,
          offset,
          files: page,
        },
        nextCursor,
      );
    }

    const { page, nextCursor } = paginate(result.matches, offset, limit);
    return wrap(
      {
        pattern,
        path: canonical,
        mode: 'content',
        totalMatches: result.totalMatches,
        totalFiles: result.totalFiles,
        truncated: result.truncated,
        returned: page.length,
        offset,
        matches: page,
      },
      nextCursor,
    );
  },
};
