import { statSync } from 'node:fs';
import { glob as tinyglob } from 'tinyglobby';
import { buildIgnoreFilter } from './ignore';
import { LIMITS } from './limits';

export interface GlobEntry {
  path: string;
  size: number;
  mtime: string;
}

export interface GlobResult {
  entries: GlobEntry[];
  totalFound: number;
  truncated: boolean;
}

export interface GlobOptions {
  pattern: string;
  cwd: string;
  respectGitignore?: boolean;
  userIgnore?: string[];
  limit?: number;
  includeDirs?: boolean;
  dot?: boolean;
}

export async function runGlob(options: GlobOptions): Promise<GlobResult> {
  const limit = Math.min(options.limit ?? LIMITS.DEFAULT_LIST_LIMIT, LIMITS.MAX_GLOB_RESULTS);
  const filter = buildIgnoreFilter({
    root: options.cwd,
    userPatterns: options.userIgnore,
    respectGitignore: options.respectGitignore,
  });

  const raw = await tinyglob(options.pattern, {
    cwd: options.cwd,
    absolute: true,
    onlyFiles: !options.includeDirs,
    dot: options.dot ?? false,
    expandDirectories: false,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  const withStat: GlobEntry[] = [];
  for (const absolute of raw) {
    const relative = absolute.startsWith(options.cwd)
      ? absolute.slice(options.cwd.length).replace(/^[/\\]+/, '')
      : absolute;
    if (filter.ignores(relative)) continue;
    try {
      const st = statSync(absolute);
      withStat.push({
        path: absolute,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch {
      // skip unreadable entries
    }
  }

  withStat.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));

  const truncated = withStat.length > limit;
  return {
    entries: truncated ? withStat.slice(0, limit) : withStat,
    totalFound: withStat.length,
    truncated,
  };
}
