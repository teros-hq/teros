import ignoreLib from 'ignore';

const DEFAULT_EXCLUDES = ['node_modules', '.git', '.DS_Store'];

export interface IgnoreFilter {
  ignores(relativePath: string): boolean;
}

export function buildIgnoreFilter(options: {
  root?: string; // No longer used — kept for API compat
  userPatterns?: string[];
  respectGitignore?: boolean;
  gitignoreContent?: string; // Pre-read .gitignore content (caller provides it)
  includeDefaults?: boolean;
}): IgnoreFilter {
  const ig = ignoreLib();

  if (options.includeDefaults !== false) {
    ig.add(DEFAULT_EXCLUDES);
  }

  if (options.userPatterns?.length) {
    ig.add(options.userPatterns);
  }

  // In the ctx.volume architecture, the caller can pass pre-read .gitignore
  // content via gitignoreContent. We no longer read from the local filesystem.
  if (options.respectGitignore && options.gitignoreContent) {
    try {
      ig.add(options.gitignoreContent);
    } catch {
      // Best-effort: malformed .gitignore content is not fatal
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
