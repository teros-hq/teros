/**
 * GitHub MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 41/41 tools covered. `FallbackRenderer` is a dev-only warning signalling
 * a missing entry in the RENDERERS map — in production it should never
 * render.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';

import {
  Badge,
  colors as globalColors,
  FallbackBody,
  ToolCallCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { withPermissionSupport } from '../../withPermissionSupport';

import {
  CancelWorkflowRunRenderer,
  GetWorkflowRunRenderer,
  ListWorkflowRunJobsRenderer,
  ListWorkflowRunsRenderer,
  ListWorkflowsRenderer,
  RerunWorkflowRunRenderer,
  TriggerWorkflowRenderer,
} from './ActionsRenderer';
import {
  CreateBranchRenderer,
  GetBranchRenderer,
  ListBranchesRenderer,
} from './BranchRenderer';
import { CreateCheckRunRenderer, UpdateCheckRunRenderer } from './ChecksRenderer';
import {
  CompareCommitsRenderer,
  GetCommitRenderer,
  ListCommitsRenderer,
} from './CommitRenderer';
import { DispatchEventRenderer } from './DispatchEventRenderer';
import { HealthCheckRenderer } from './HealthCheckRenderer';
import {
  AddIssueCommentRenderer,
  AddLabelsToIssueRenderer,
  CreateIssueRenderer,
  GetIssueRenderer,
  ListIssuesRenderer,
  SearchIssuesRenderer,
  UpdateIssueRenderer,
} from './IssueRenderer';
import {
  CloneRepoRenderer,
  CreateOrUpdateFileRenderer,
  GetFileContentRenderer,
  GetUserRenderer,
  SearchCodeRenderer,
} from './MiscRenderer';
import {
  CreatePrReviewRenderer,
  CreatePullRenderer,
  GetPullRenderer,
  ListPrCommitsRenderer,
  ListPrFilesRenderer,
  ListPrReviewCommentsRenderer,
  ListPullsRenderer,
  MergePullRenderer,
  RequestReviewersRenderer,
} from './PullRequestRenderer';
import { RateLimitRenderer } from './RateLimitRenderer';
import {
  CreateReleaseRenderer,
  ListReleasesRenderer,
} from './ReleaseRenderer';
import {
  CreateRepoRenderer,
  GetRepoRenderer,
  ListReposRenderer,
  SearchReposRenderer,
} from './RepoRenderer';
import { GitOperationRenderer, GitStatusRenderer } from './GitLocalRenderer';
import {
  GitBatchCommitRenderer,
  GitBlameRenderer,
  GitDiffRenderer,
  GitListFilesRenderer,
  GitLogRenderer,
} from './GitLocalP1Renderer';
import { GITHUB_ICON, getShortToolName, getToolLabel, toolStatusForPrimitive } from './shared';

// =============================================================================
// Registry — 71/71 coverage (1 health + 45 remote + 25 local git)
// =============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,

  // Repos
  'list-repos': ListReposRenderer,
  'get-repo': GetRepoRenderer,
  'create-repo': CreateRepoRenderer,
  'search-repos': SearchReposRenderer,

  // Issues
  'list-issues': ListIssuesRenderer,
  'get-issue': GetIssueRenderer,
  'create-issue': CreateIssueRenderer,
  'update-issue': UpdateIssueRenderer,
  'add-issue-comment': AddIssueCommentRenderer,
  'add-labels-to-issue': AddLabelsToIssueRenderer,
  'search-issues': SearchIssuesRenderer,

  // Pull requests
  'list-pulls': ListPullsRenderer,
  'get-pull': GetPullRenderer,
  'create-pull': CreatePullRenderer,
  'merge-pull': MergePullRenderer,
  'list-pr-files': ListPrFilesRenderer,
  'list-pr-commits': ListPrCommitsRenderer,
  'list-pr-review-comments': ListPrReviewCommentsRenderer,
  'request-reviewers': RequestReviewersRenderer,
  'create-pr-review': CreatePrReviewRenderer,

  // Branches
  'list-branches': ListBranchesRenderer,
  'get-branch': GetBranchRenderer,
  'create-branch': CreateBranchRenderer,

  // Commits
  'list-commits': ListCommitsRenderer,
  'get-commit': GetCommitRenderer,
  'compare-commits': CompareCommitsRenderer,

  // Actions / Workflows
  'list-workflows': ListWorkflowsRenderer,
  'list-workflow-runs': ListWorkflowRunsRenderer,
  'get-workflow-run': GetWorkflowRunRenderer,
  'list-workflow-run-jobs': ListWorkflowRunJobsRenderer,
  'trigger-workflow': TriggerWorkflowRenderer,
  'rerun-workflow-run': RerunWorkflowRunRenderer,
  'cancel-workflow-run': CancelWorkflowRunRenderer,

  // Releases
  'list-releases': ListReleasesRenderer,
  'create-release': CreateReleaseRenderer,

  // Files
  'get-file-content': GetFileContentRenderer,
  'create-or-update-file': CreateOrUpdateFileRenderer,

  // Search
  'search-code': SearchCodeRenderer,

  // Users / git ops
  'get-user': GetUserRenderer,
  'get-installation-context': GetUserRenderer,
  'clone-repo': CloneRepoRenderer,

  // Check runs (App-only)
  'create-check-run': CreateCheckRunRenderer,
  'update-check-run': UpdateCheckRunRenderer,

  // Misc App utilities
  'get-rate-limit': RateLimitRenderer,
  'dispatch-event': DispatchEventRenderer,

  // Local git operations (v5.1+) — P0
  'git-status': GitStatusRenderer,
  'git-add': GitOperationRenderer,
  'git-commit': GitOperationRenderer,
  'git-push': GitOperationRenderer,
  'git-checkout': GitOperationRenderer,

  // Local git operations (v5.1+) — P1
  'git-rm': GitOperationRenderer,
  'git-mv': GitOperationRenderer,
  'git-read-file': GitOperationRenderer,
  'git-write-file': GitOperationRenderer,
  'git-list-files': GitListFilesRenderer,
  'git-pull': GitOperationRenderer,
  'git-diff': GitDiffRenderer,
  'git-log': GitLogRenderer,
  'git-batch-commit': GitBatchCommitRenderer,

  // Local git operations (v5.1+) — P2 history rewriting
  'git-stash': GitOperationRenderer,
  'git-merge': GitOperationRenderer,
  'git-rebase': GitOperationRenderer,
  'git-reset': GitOperationRenderer,
  'git-cherry-pick': GitOperationRenderer,

  // Local git operations (v5.1+) — P2 config & metadata
  'git-config': GitOperationRenderer,
  'git-tag': GitOperationRenderer,
  'git-remote': GitOperationRenderer,

  // Local git operations (v5.1+) — P3 debugging
  'git-blame': GitBlameRenderer,
  'git-bisect': GitOperationRenderer,

  // Extra — sync without merge (replaces gh pr checkout via custom refspec)
  'git-fetch': GitOperationRenderer,
};

// =============================================================================
// FallbackRenderer — dev-only warning. In production it should never render.
// =============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={GITHUB_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in GitHubRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

// =============================================================================
// Entry point
// =============================================================================

function GitHubRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const GitHubToolCallRenderer = withPermissionSupport(GitHubRendererBase);
export default GitHubToolCallRenderer;
