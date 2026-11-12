// @fixme nira - 2026.09.26: search-in-files uses ripgrep (execa + rg binary) which requires real filesystem access.
// Cannot be migrated to ctx.volume without reimplementing content search in-memory (read each file
// via ctx.volume.read, then regex match in JS). Left with native fs temporarily — the local root is
// resolved by resolveLocalRoot() (container mount, owner workspace hostPath via MCA_WORKSPACE_PATH,
// or host root for the admin role). When the MCA runs without a local mount, search-in-files will
// need to be reimplemented using ctx.volume.list to enumerate files + ctx.volume.read to fetch
// content + in-memory regex matching.
import type { ToolConfig } from '@teros/mca-sdk';
import { LIMITS } from '../lib/limits';
import { resolveLocalRoot } from '../lib/local-root';
import { defaultRootPath, getDefaultGuard, toUserPath } from '../lib/path-safety';
import { runRipgrep } from '../lib/ripgrep';
import { decodeCursor, paginate, wrap } from '../lib/structured';

export const searchInFiles: ToolConfig = {
  description:
    'Search file contents for a regex pattern using ripgrep. `output_mode` controls the shape: "content" returns {file, line, match, context} objects; "files" returns one entry per matching file with matchCount; "count" returns only totals. Supports context lines (-B/-A), include glob, case insensitive, multiline. Shell-injection safe (args are not interpolated). For finding files by name use `find-files`.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern (Rust regex syntax via ripgrep)' },
      path: { type: 'string', description: 'Base directory or file (default: `/workspace`, the volume root)' },
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
    const basePath = (args.path as string | undefined) ?? defaultRootPath();
    const volumePath = guard.resolve(basePath);

    // @fixme: ripgrep needs a real filesystem path. Map volume-relative to the local
    // root — container mount, owner workspace hostPath (MCA_WORKSPACE_PATH, stdio mode),
    // or host root for the admin role. Never the global host symlink of another workspace.
    const localRoot = resolveLocalRoot();
    const localPath = volumePath === '/' ? localRoot : `${localRoot}${volumePath}`;

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
      path: localPath,
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

    // Convert local paths in results back to user-facing paths (/workspace-prefixed
    // in the workspace role; host paths as-is in the admin role)
    const stripPrefix = (p: string) => p.startsWith(localRoot) ? toUserPath(p.slice(localRoot.length) || '/') : p;
    const volumeMatches = result.matches.map((m) => ({ ...m, file: stripPrefix(m.file) }));
    const volumeFiles = result.files.map((f) => ({ ...f, file: stripPrefix(f.file) }));

    if (outputMode === 'count') {
      return wrap({
        pattern,
        path: toUserPath(volumePath),
        mode: 'count',
        totalMatches: result.totalMatches,
        totalFiles: result.totalFiles,
        truncated: result.truncated,
      });
    }

    if (outputMode === 'files') {
      const { page, nextCursor } = paginate(volumeFiles, offset, limit);
      return wrap(
        {
          pattern,
          path: toUserPath(volumePath),
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

    const { page, nextCursor } = paginate(volumeMatches, offset, limit);
    return wrap(
      {
        pattern,
        path: toUserPath(volumePath),
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
