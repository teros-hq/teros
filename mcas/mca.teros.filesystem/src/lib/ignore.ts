import ignoreLib from 'ignore';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store'];

export interface IgnoreFilter {
  ignores(relativePath: string): boolean;
}

export function buildIgnoreFilter(options: {
  root: string;
  userPatterns?: string[];
  respectGitignore?: boolean;
  includeDefaults?: boolean;
}): IgnoreFilter {
  const ig = ignoreLib();

  if (options.includeDefaults !== false) {
    ig.add(DEFAULT_EXCLUDES);
  }

  if (options.userPatterns?.length) {
    ig.add(options.userPatterns);
  }

  if (options.respectGitignore) {
    const gitignorePath = join(options.root, '.gitignore');
    if (existsSync(gitignorePath)) {
      try {
        const contents = readFileSync(gitignorePath, 'utf-8');
        ig.add(contents);
      } catch {
        // Best-effort: missing or unreadable .gitignore is not fatal
      }
    }
  }

  return {
    ignores(relativePath) {
      if (!relativePath || relativePath === '.' || relativePath === '/') return false;
      const normalized = relativePath.replace(/^[/\\]+/, '');
      return normalized ? ig.ignores(normalized) : false;
    },
  };
}
