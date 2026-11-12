import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import { scheduleAgentCleanup } from '../lib/clone-cleanup';
import { GitHubApiError } from '../lib/github-client';
import { GitHubAppNotInstalledError, GitHubUserNotAuthenticatedError } from '../lib/github-user-token';
import { classifyGitHubError, formatClassifiedGitHubError } from './_github-error';
import * as tools from './index';

const ALREADY_CLASSIFIED_RE = /^\[[A-Z_]+\] [\s\S]*\nWhat to do: /;

function isGitHubFailure(error: unknown): boolean {
  return (
    error instanceof GitHubApiError ||
    error instanceof GitHubUserNotAuthenticatedError ||
    error instanceof GitHubAppNotInstalledError ||
    (error instanceof TypeError && /fetch failed|network/i.test(error.message))
  );
}

async function appSlugOf(context: ToolContext): Promise<string | undefined> {
  try {
    return (await context.getSystemSecrets()).GITHUB_APP_SLUG;
  } catch {
    return undefined;
  }
}

export async function toAgentError(error: unknown, context: ToolContext): Promise<Error> {
  if (error instanceof Error && ALREADY_CLASSIFIED_RE.test(error.message)) return error;
  if (error instanceof TypeError && !isGitHubFailure(error)) {
    return new Error(
      `[UNEXPECTED] ${error.message}\nWhat to do: The GitHub tool failed on its side; the request may already have reached GitHub. Check the result (get or list it) before retrying, and tell the user if it keeps failing.`,
    );
  }
  if (!isGitHubFailure(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      `[INVALID_INPUT] ${message.replace(/^\[[A-Z_]+\]\s*/, '')}\nWhat to do: Fix the arguments as the message says and call the tool again; nothing was sent to GitHub.`,
    );
  }
  const classified = classifyGitHubError(error, { appSlug: await appSlugOf(context) });
  const wrapped = new Error(formatClassifiedGitHubError(classified)) as Error & { code?: string; status?: number };
  wrapped.code = classified.code;
  wrapped.status = classified.status;
  return wrapped;
}

const BODY_LIMITS: Record<string, number> = {
  'create-pull': 65_536,
  'create-issue': 65_536,
  'update-issue': 65_536,
  'add-issue-comment': 65_536,
  'create-pr-review': 65_536,
  'create-release': 125_000,
};

function assertBodyFits(name: string, args: unknown): void {
  const limit = BODY_LIMITS[name];
  const body = (args as { body?: unknown } | undefined)?.body;
  if (!limit || typeof body !== 'string' || body.length <= limit) return;
  throw new Error(
    `[BODY_TOO_LONG] The body is ${body.length.toLocaleString('en-US')} characters; GitHub accepts at most ${limit.toLocaleString('en-US')} here.\n` +
      'What to do: shorten it to a summary. Put long material (logs, full diffs, generated reports) in a file in the repository or split it over several comments, and link to it.',
  );
}

export function restTool(tool: ToolConfig, name?: string): ToolConfig {
  return {
    ...tool,
    handler: async (args, context) => {
      try {
        if (name) assertBodyFits(name, args);
        const result = await tool.handler(args, context);
        scheduleAgentCleanup(context);
        return result;
      } catch (error) {
        throw await toAgentError(error, context);
      }
    },
  };
}

const RAW_REST_TOOLS: Record<string, ToolConfig> = {
  'list-repos': tools.listRepos,
  'get-repo': tools.getRepo,
  'create-repo': tools.createRepo,
  'list-issues': tools.listIssues,
  'get-issue': tools.getIssue,
  'create-issue': tools.createIssue,
  'update-issue': tools.updateIssue,
  'add-issue-comment': tools.addIssueComment,
  'add-labels-to-issue': tools.addLabelsToIssue,
  'search-issues': tools.searchIssues,
  'list-pulls': tools.listPulls,
  'get-pull': tools.getPull,
  'create-pull': tools.createPull,
  'merge-pull': tools.mergePull,
  'list-pr-files': tools.listPrFiles,
  'list-pr-commits': tools.listPrCommits,
  'list-pr-review-comments': tools.listPrReviewComments,
  'request-reviewers': tools.requestReviewers,
  'create-pr-review': tools.createPrReview,
  'list-branches': tools.listBranches,
  'get-branch': tools.getBranch,
  'create-branch': tools.createBranch,
  'list-commits': tools.listCommits,
  'get-commit': tools.getCommit,
  'compare-commits': tools.compareCommits,
  'list-workflows': tools.listWorkflows,
  'list-workflow-runs': tools.listWorkflowRuns,
  'get-workflow-run': tools.getWorkflowRun,
  'list-workflow-run-jobs': tools.listWorkflowRunJobs,
  'trigger-workflow': tools.triggerWorkflow,
  'rerun-workflow-run': tools.rerunWorkflowRun,
  'cancel-workflow-run': tools.cancelWorkflowRun,
  'list-releases': tools.listReleases,
  'create-release': tools.createRelease,
  'get-file-content': tools.getFileContent,
  'create-or-update-file': tools.createOrUpdateFile,
  'search-repos': tools.searchRepos,
  'search-code': tools.searchCode,
  'get-installation-context': tools.getInstallationContext,
  'get-user': tools.getUser,
  'get-rate-limit': tools.getRateLimit,
  'dispatch-event': tools.dispatchEvent,
};

export const REST_TOOLS: Record<string, ToolConfig> = Object.fromEntries(
  Object.entries(RAW_REST_TOOLS).map(([name, tool]) => [name, restTool(tool, name)]),
);
