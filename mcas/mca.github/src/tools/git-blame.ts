import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertIsRepo, resolveRepoPath, runGit } from '../lib/git-local';
import { throwClassifiedGitError } from './_git-error';

interface BlameLine {
  sha: string;
  author: string;
  authorEmail: string;
  date: string;
  lineNumber: number;
  content: string;
}

/**
 * Per-line attribution for a file: who wrote each line and when. Uses
 * `git blame --porcelain` so the parser doesn't depend on column widths.
 */
export const gitBlame: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Per-line attribution for a file. Returns `[{ sha, author, date, lineNumber, content }]`. Restrict with `range: "10,50"` or `ref`.',
  parameters: {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      owner: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string', description: 'File path relative to repo root.' },
      ref: { type: 'string', description: 'Blame at a specific ref (default HEAD).' },
      range: { type: 'string', description: 'Optional line range `start,end` (1-indexed inclusive).' },
    },
    required: ['path'],
  },
  handler: async (args, _context) => {
    const a = args as {
      repoPath?: string;
      owner?: string;
      repo?: string;
      path: string;
      ref?: string;
      range?: string;
    };
    const repoPath = resolveRepoPath(a);
    assertIsRepo(repoPath);

    const argv: string[] = ['blame', '--porcelain'];
    if (a.range) argv.push('-L', a.range);
    if (a.ref) argv.push(a.ref);
    argv.push('--', a.path);

    const result = runGit(repoPath, argv);
    if (result.code !== 0) throwClassifiedGitError(result);

    // Porcelain format:
    //   <sha> <orig> <final> [<group-size>]
    //   author <name>
    //   author-mail <email>
    //   author-time <unix>
    //   ...
    //   \t<line content>
    const commitsMeta: Record<string, { author: string; authorEmail: string; date: string }> = {};
    const lines: BlameLine[] = [];
    let currentSha = '';
    let currentLineNumber = 0;
    let pending: Partial<{ author: string; authorEmail: string; authorTime: number }> = {};

    for (const raw of result.stdout.split('\n')) {
      if (/^[0-9a-f]{40}\s/.test(raw)) {
        const parts = raw.split(' ');
        currentSha = parts[0];
        currentLineNumber = Number.parseInt(parts[2], 10);
        pending = {};
        continue;
      }
      if (raw.startsWith('author ')) pending.author = raw.slice(7);
      else if (raw.startsWith('author-mail ')) pending.authorEmail = raw.slice(12).replace(/[<>]/g, '');
      else if (raw.startsWith('author-time ')) pending.authorTime = Number.parseInt(raw.slice(12), 10);
      else if (raw.startsWith('\t')) {
        // End of header for this line; finalize the commit metadata.
        if (!commitsMeta[currentSha] && pending.author) {
          commitsMeta[currentSha] = {
            author: pending.author,
            authorEmail: pending.authorEmail ?? '',
            date: pending.authorTime ? new Date(pending.authorTime * 1000).toISOString() : '',
          };
        }
        const meta = commitsMeta[currentSha] ?? { author: '', authorEmail: '', date: '' };
        lines.push({
          sha: currentSha,
          author: meta.author,
          authorEmail: meta.authorEmail,
          date: meta.date,
          lineNumber: currentLineNumber,
          content: raw.slice(1),
        });
      }
    }

    return {
      repoPath,
      path: a.path,
      ref: a.ref ?? 'HEAD',
      total: lines.length,
      lines,
    };
  },
};
