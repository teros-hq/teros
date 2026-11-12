import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { cleanupClone, githubPrState } from '../lib/clone-cleanup';
import { assertIsRepo, resolveRepoPath } from '../lib/git-local';
import { budgetedGitTool } from './_locked';

export const gitCleanup: ToolConfig = budgetedGitTool(
  {
    annotations: { readOnlyHint: false, destructiveHint: false },
    description:
      'Free your clone of a repository when you are done with it. If it holds work that is not on GitHub yet (uncommitted changes, untracked files, stashes, unpushed commits), that work is first committed to a branch teros/saved/<agent>/<branch>-<date> and pushed to the same repository, after a secret scan and the 100 MB and Workflows checks; only then is the clone removed. If saving is not possible the clone is kept and the reason is returned. The next git tool call on that repository clones it again by itself.',
    parameters: {
      type: 'object',
      properties: {
        repoPath: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
    },
    handler: async (args, context) => {
      const repoPath = resolveRepoPath(args as Record<string, string | undefined>);
      assertIsRepo(repoPath);
      const result = await cleanupClone(repoPath, {
        context,
        prState: githubPrState(context),
        why: 'The agent freed this clone with git-cleanup; this branch keeps the work that was not on GitHub yet.',
      });
      return { repoPath, ...result };
    },
  },
  { noRestore: true },
);
