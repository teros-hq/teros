export { listRepos } from './list-repos';
export { getRepo } from './get-repo';
export { createRepo } from './create-repo';

export { listIssues } from './list-issues';
export { getIssue } from './get-issue';
export { createIssue } from './create-issue';
export { updateIssue } from './update-issue';
export { addIssueComment } from './add-issue-comment';
export { addLabelsToIssue } from './add-labels-to-issue';
export { searchIssues } from './search-issues';

export { listPulls } from './list-pulls';
export { getPull } from './get-pull';
export { createPull } from './create-pull';
export { mergePull } from './merge-pull';
export { listPrFiles } from './list-pr-files';
export { listPrCommits } from './list-pr-commits';
export { listPrReviewComments } from './list-pr-review-comments';
export { requestReviewers } from './request-reviewers';
export { createPrReview } from './create-pr-review';

export { listBranches } from './list-branches';
export { getBranch } from './get-branch';
export { createBranch } from './create-branch';

export { listCommits } from './list-commits';
export { getCommit } from './get-commit';
export { compareCommits } from './compare-commits';

export { listWorkflows } from './list-workflows';
export { listWorkflowRuns } from './list-workflow-runs';
export { getWorkflowRun } from './get-workflow-run';
export { listWorkflowRunJobs } from './list-workflow-run-jobs';
export { triggerWorkflow } from './trigger-workflow';
export { rerunWorkflowRun } from './rerun-workflow-run';
export { cancelWorkflowRun } from './cancel-workflow-run';

export { listReleases } from './list-releases';
export { createRelease } from './create-release';

export { getFileContent } from './get-file-content';
export { createOrUpdateFile } from './create-or-update-file';

export { searchRepos } from './search-repos';
export { searchCode } from './search-code';

export { getInstallationContext, getUser } from './get-installation-context';
export { cloneRepo } from './clone-repo';

export { createCheckRun } from './create-check-run';
export { updateCheckRun } from './update-check-run';
export { getRateLimit } from './get-rate-limit';
export { dispatchEvent } from './dispatch-event';

export { classifyGitHubError } from './_github-error';
export type {
  ClassifiedGitHubError,
  GitHubIssueAction,
  GitHubIssueCode,
} from './_github-error';

// Local git operations (v5.1+) — operate on cloned repos under the workspace
// volume. See `lib/git-local.ts` for the shared helper and `_git-error.ts` for
// the classifier.

// P0 — Core operations
export { gitStatus } from './git-status';
export { gitAdd } from './git-add';
export { gitCommit } from './git-commit';
export { gitPush } from './git-push';
export { gitCheckout } from './git-checkout';

// P1 — File ops, sync, diff/log, batch commit
export { gitRm } from './git-rm';
export { gitMv } from './git-mv';
export { gitReadFile } from './git-read-file';
export { gitWriteFile } from './git-write-file';
export { gitListFiles } from './git-list-files';
export { gitPull } from './git-pull';
export { gitDiff } from './git-diff';
export { gitLog } from './git-log';
export { gitBatchCommit } from './git-batch-commit';

// P2 — History rewriting + sync alternatives
export { gitStash } from './git-stash';
export { gitMerge } from './git-merge';
export { gitRebase } from './git-rebase';
export { gitReset } from './git-reset';
export { gitCherryPick } from './git-cherry-pick';

// P2 — Configuration & metadata
export { gitConfig } from './git-config';
export { gitTag } from './git-tag';
export { gitRemote } from './git-remote';

// P3 — Debugging / analysis
export { gitBlame } from './git-blame';
export { gitBisect } from './git-bisect';

// Extra — sync without merge (lets the agent fetch arbitrary refspecs, e.g.
// `pull/<n>/head:pr-<n>` to pull-checkout a PR without invoking gh CLI).
export { gitFetch } from './git-fetch';

export { classifyGitError, throwClassifiedGitError } from './_git-error';
export type { ClassifiedGitError, GitIssueAction, GitIssueCode } from './_git-error';
