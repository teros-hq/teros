/**
 * GitHub MCA — constants, types, helpers, and a compose-only `GitHubToolShell`.
 *
 * Zero components are defined here. The global primitives
 * (`IconChip`, `IconTile`, `PillList`, `ResourceCard`, `EntityRow`,
 * `ActionBadge`, `ToolCallCard`, `Avatar`, `KeyValueGrid`, …) cover every
 * GitHub-specific UI case through props. What lives here:
 *
 *  - Constants: official GitHub Primer palette + brand accent + logo url.
 *  - Types for curated GitHub shapes (tolerant unions).
 *  - Shape-agnostic getters (`getRepoFullName`, `getPrState`, …).
 *  - **Prop factories** that feed the global primitives:
 *      `prStateChipProps(pr)`, `issueStateChipProps(issue)`,
 *      `runStatusChipProps(run)`, `labelChipProps(label)`,
 *      `repoVisibilityChipProps(repo)`.
 *  - `scrollStyle(maxHeight)` for theme-adaptive thin scrollbars on web.
 *  - `GitHubToolShell` — compose-only wrapper over `ToolCallCard` that
 *    pre-fills `iconUri={GITHUB_ICON}` and the description label.
 */

import type React from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Lock,
  MinusCircle,
  Pause,
  Play,
  RefreshCw,
  Star,
  Tag,
  ToolCallCard,
  useColors,
  XCircle,
  Zap,
} from '../../primitives';
import type { McaStatusType } from '../../primitives/colors';
import type { ToolCallRendererProps } from '../../types';

// =============================================================================
// Brand
// =============================================================================

export const GITHUB_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL ?? ''}/static/github-icon.png`;

/**
 * Official GitHub Primer palette. Validated against the GitHub UI itself
 * (https://github.com/primer/primitives). Hex values are REAL — do NOT
 * substitute Tailwind defaults (`#ef4444` red, `#3b82f6` blue, …).
 */
export const GITHUB_PALETTE = {
  brand: '#24292F',
  open: '#1A7F37',
  closed: '#6E7781',
  closedNotPlanned: '#6E7781',
  merged: '#8250DF',
  draft: '#6E7781',
  failed: '#CF222E',
  success: '#1A7F37',
  inProgress: '#9A6700',
  queued: '#0969DA',
  cancelled: '#6E7781',
  skipped: '#6E7781',
  neutral: '#6E7781',
  warning: '#9A6700',
  privateLock: '#9A6700',
  publicGreen: '#1A7F37',
  internalBlue: '#0969DA',
} as const;

// =============================================================================
// Types — tolerant of curated + raw GitHub shapes
// =============================================================================

export interface GitHubUserRef {
  id?: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface GitHubLabel {
  id?: number;
  name: string;
  color?: string;
  description?: string | null;
}

export interface GitHubRepo {
  id?: number;
  name: string;
  full_name: string;
  private: boolean;
  visibility?: 'public' | 'private' | 'internal';
  description?: string | null;
  default_branch?: string;
  language?: string | null;
  topics?: string[];
  license?: { key: string; name: string; spdx_id?: string } | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  html_url?: string;
  owner?: GitHubUserRef;
  pushed_at?: string;
  updated_at?: string;
}

export interface GitHubIssue {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  state_reason?: 'completed' | 'not_planned' | 'reopened' | null;
  user?: GitHubUserRef;
  labels?: GitHubLabel[] | string[];
  assignees?: GitHubUserRef[];
  comments?: number;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  pull_request?: { url: string; html_url: string };
}

export interface GitHubPull {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  user?: GitHubUserRef;
  head?: { ref: string; sha: string; label?: string };
  base?: { ref: string; sha: string; label?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  comments?: number;
  requested_reviewers?: GitHubUserRef[];
  requested_teams?: Array<{ slug: string; name: string }>;
  labels?: GitHubLabel[];
  html_url?: string;
  merged_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GitHubBranch {
  name: string;
  commit?: { sha: string; url?: string };
  protected?: boolean;
}

export interface GitHubCommit {
  sha: string;
  commit?: {
    message: string;
    author?: { name: string; email: string; date: string };
    committer?: { name: string; email: string; date: string };
  };
  author?: GitHubUserRef | null;
  committer?: GitHubUserRef | null;
  html_url?: string;
  stats?: { total: number; additions: number; deletions: number };
  files?: Array<GitHubFileChange>;
}

export interface GitHubFileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url?: string;
  sha?: string;
  previous_filename?: string;
}

export type GitHubRunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'requested'
  | 'waiting'
  | 'pending'
  | 'action_required';

export type GitHubRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'neutral'
  | 'action_required'
  | 'stale'
  | null;

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state?: string;
  badge_url?: string;
  html_url?: string;
}

export interface GitHubWorkflowRun {
  id: number;
  name?: string;
  display_title?: string;
  status: GitHubRunStatus;
  conclusion: GitHubRunConclusion;
  run_number?: number;
  event?: string;
  head_branch?: string;
  head_sha?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string;
  workflow_id?: number;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: GitHubRunStatus;
  conclusion: GitHubRunConclusion;
  started_at?: string;
  completed_at?: string;
  html_url?: string;
  steps?: Array<{ name: string; status: GitHubRunStatus; conclusion: GitHubRunConclusion; number: number }>;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url?: string;
  published_at?: string | null;
  created_at?: string;
  author?: GitHubUserRef;
}

export interface GitHubReviewComment {
  id: number;
  user?: GitHubUserRef;
  body: string;
  path: string;
  line?: number | null;
  position?: number | null;
  commit_id?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
}

// =============================================================================
// Helpers (data, not UI)
// =============================================================================

export function getRepoFullName(repo: Partial<GitHubRepo> | undefined): string {
  if (!repo) return '';
  if (repo.full_name) return repo.full_name;
  if (repo.owner?.login && repo.name) return `${repo.owner.login}/${repo.name}`;
  return repo.name ?? '';
}

export function sanitizeLabelColor(color: string | undefined): string | null {
  if (!color || typeof color !== 'string') return null;
  const trimmed = color.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3,8}$/.test(trimmed)) return null;
  return `#${trimmed}`;
}

export function relativeTime(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const sign = diff < 0 ? 'in ' : '';
  const suffix = diff < 0 ? '' : ' ago';
  if (abs < 60_000) return `${sign}just now${suffix === ' ago' ? '' : suffix}`;
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000) return `${sign}${Math.round(abs / 3_600_000)}h${suffix}`;
  if (abs < 30 * 86_400_000) return `${sign}${Math.round(abs / 86_400_000)}d${suffix}`;
  return new Date(t).toISOString().slice(0, 10);
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function shortSha(sha: string | undefined): string {
  if (!sha) return '';
  return sha.slice(0, 7);
}

// =============================================================================
// Tool name helpers
// =============================================================================

const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  'list-repos': 'List repositories',
  'get-repo': 'Get repository',
  'create-repo': 'Create repository',
  'list-issues': 'List issues',
  'get-issue': 'Get issue',
  'create-issue': 'Create issue',
  'update-issue': 'Update issue',
  'add-issue-comment': 'Add comment',
  'add-labels-to-issue': 'Add labels',
  'search-issues': 'Search issues',
  'list-pulls': 'List pull requests',
  'get-pull': 'Get pull request',
  'create-pull': 'Create pull request',
  'merge-pull': 'Merge pull request',
  'list-pr-files': 'PR files',
  'list-pr-commits': 'PR commits',
  'list-pr-review-comments': 'PR review comments',
  'request-reviewers': 'Request reviewers',
  'create-pr-review': 'Submit PR review',
  'list-branches': 'List branches',
  'get-branch': 'Get branch',
  'create-branch': 'Create branch',
  'list-commits': 'List commits',
  'get-commit': 'Get commit',
  'compare-commits': 'Compare',
  'list-workflows': 'List workflows',
  'list-workflow-runs': 'List workflow runs',
  'get-workflow-run': 'Get workflow run',
  'list-workflow-run-jobs': 'List workflow jobs',
  'trigger-workflow': 'Trigger workflow',
  'rerun-workflow-run': 'Re-run workflow',
  'cancel-workflow-run': 'Cancel workflow',
  'list-releases': 'List releases',
  'create-release': 'Create release',
  'get-file-content': 'Get file',
  'create-or-update-file': 'Write file',
  'search-repos': 'Search repositories',
  'search-code': 'Search code',
  'get-user': 'Get user',
  'clone-repo': 'Clone repository',
};

export function getShortToolName(toolName: string): string {
  if (!toolName) return '';
  // Tool names arrive prefixed by the user-given app name + underscore at
  // runtime (e.g. `github_list-repos`, `my-gh_get-issue`). The RENDERERS map
  // is keyed by the canonical short name from `tools.json` (e.g.
  // `list-repos`, `-health-check`). Split by `_` and take the last segment.
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? short.replace(/-/g, ' ');
}

// =============================================================================
// Prop factories — feed the global primitives
// =============================================================================

export interface ChipProps {
  icon?: React.ReactNode;
  text: string;
  accent?: string;
  outline?: boolean;
}

export function prStateChipProps(pr: Partial<GitHubPull>): ChipProps {
  if (pr.merged_at || pr.merged) {
    return {
      icon: <GitMerge size={9} color={GITHUB_PALETTE.merged} />,
      text: 'merged',
      accent: GITHUB_PALETTE.merged,
    };
  }
  if (pr.state === 'closed') {
    return {
      icon: <GitPullRequestClosed size={9} color={GITHUB_PALETTE.failed} />,
      text: 'closed',
      accent: GITHUB_PALETTE.failed,
    };
  }
  if (pr.draft) {
    return {
      icon: <GitPullRequestDraft size={9} color={GITHUB_PALETTE.draft} />,
      text: 'draft',
      accent: GITHUB_PALETTE.draft,
    };
  }
  return {
    icon: <GitPullRequest size={9} color={GITHUB_PALETTE.open} />,
    text: 'open',
    accent: GITHUB_PALETTE.open,
  };
}

export function issueStateChipProps(issue: Partial<GitHubIssue>): ChipProps {
  if (issue.state === 'closed') {
    if (issue.state_reason === 'not_planned') {
      return {
        icon: <MinusCircle size={9} color={GITHUB_PALETTE.closedNotPlanned} />,
        text: 'not planned',
        accent: GITHUB_PALETTE.closedNotPlanned,
      };
    }
    return {
      icon: <CheckCircle2 size={9} color={GITHUB_PALETTE.merged} />,
      text: 'closed',
      accent: GITHUB_PALETTE.merged,
    };
  }
  return {
    icon: <AlertCircle size={9} color={GITHUB_PALETTE.open} />,
    text: 'open',
    accent: GITHUB_PALETTE.open,
  };
}

export function runStatusChipProps(run: Pick<GitHubWorkflowRun, 'status' | 'conclusion'>): ChipProps {
  if (run.status === 'completed') {
    switch (run.conclusion) {
      case 'success':
        return { icon: <CheckCircle2 size={9} color={GITHUB_PALETTE.success} />, text: 'success', accent: GITHUB_PALETTE.success };
      case 'failure':
      case 'timed_out':
        return { icon: <XCircle size={9} color={GITHUB_PALETTE.failed} />, text: run.conclusion ?? 'failed', accent: GITHUB_PALETTE.failed };
      case 'cancelled':
        return { icon: <Pause size={9} color={GITHUB_PALETTE.cancelled} />, text: 'cancelled', accent: GITHUB_PALETTE.cancelled };
      case 'skipped':
        return { icon: <MinusCircle size={9} color={GITHUB_PALETTE.skipped} />, text: 'skipped', accent: GITHUB_PALETTE.skipped };
      case 'neutral':
        return { icon: <Check size={9} color={GITHUB_PALETTE.neutral} />, text: 'neutral', accent: GITHUB_PALETTE.neutral };
      case 'action_required':
        return { icon: <AlertCircle size={9} color={GITHUB_PALETTE.warning} />, text: 'needs action', accent: GITHUB_PALETTE.warning };
      default:
        return { icon: <Check size={9} color={GITHUB_PALETTE.neutral} />, text: run.conclusion ?? 'completed', accent: GITHUB_PALETTE.neutral };
    }
  }
  switch (run.status) {
    case 'in_progress':
      return { icon: <RefreshCw size={9} color={GITHUB_PALETTE.inProgress} />, text: 'in progress', accent: GITHUB_PALETTE.inProgress };
    case 'queued':
    case 'pending':
    case 'requested':
      return { icon: <Clock size={9} color={GITHUB_PALETTE.queued} />, text: run.status, accent: GITHUB_PALETTE.queued };
    case 'waiting':
      return { icon: <Pause size={9} color={GITHUB_PALETTE.queued} />, text: 'waiting', accent: GITHUB_PALETTE.queued };
    case 'action_required':
      return { icon: <AlertCircle size={9} color={GITHUB_PALETTE.warning} />, text: 'needs action', accent: GITHUB_PALETTE.warning };
    default:
      return { icon: <Clock size={9} color={GITHUB_PALETTE.neutral} />, text: run.status ?? 'unknown', accent: GITHUB_PALETTE.neutral };
  }
}

export function labelChipProps(label: GitHubLabel | string): ChipProps {
  if (typeof label === 'string') {
    return { text: label, accent: GITHUB_PALETTE.neutral };
  }
  const accent = sanitizeLabelColor(label.color) ?? GITHUB_PALETTE.neutral;
  return { text: label.name, accent };
}

export function repoVisibilityChipProps(repo: Partial<GitHubRepo>): ChipProps {
  const visibility = repo.visibility ?? (repo.private ? 'private' : 'public');
  switch (visibility) {
    case 'private':
      return { icon: <Lock size={9} color={GITHUB_PALETTE.privateLock} />, text: 'private', accent: GITHUB_PALETTE.privateLock };
    case 'internal':
      return { text: 'internal', accent: GITHUB_PALETTE.internalBlue };
    default:
      return { text: 'public', accent: GITHUB_PALETTE.publicGreen };
  }
}

export function releaseChipProps(release: Partial<GitHubRelease>): ChipProps {
  if (release.draft) return { icon: <Tag size={9} color={GITHUB_PALETTE.draft} />, text: 'draft', accent: GITHUB_PALETTE.draft };
  if (release.prerelease) return { icon: <Tag size={9} color={GITHUB_PALETTE.warning} />, text: 'pre-release', accent: GITHUB_PALETTE.warning };
  return { icon: <Tag size={9} color={GITHUB_PALETTE.merged} />, text: 'release', accent: GITHUB_PALETTE.merged };
}

export function branchChipProps(branch: Partial<GitHubBranch>): ChipProps {
  if (branch.protected) {
    return { icon: <Lock size={9} color={GITHUB_PALETTE.warning} />, text: 'protected', accent: GITHUB_PALETTE.warning };
  }
  return { icon: <GitBranch size={9} color={GITHUB_PALETTE.neutral} />, text: 'branch', accent: GITHUB_PALETTE.neutral };
}

export function actionVerbAccent(verb: 'success' | 'destructive' | 'pending'): string {
  if (verb === 'success') return GITHUB_PALETTE.success;
  if (verb === 'destructive') return GITHUB_PALETTE.failed;
  return GITHUB_PALETTE.queued;
}

// =============================================================================
// Style helpers
// =============================================================================

/**
 * Style for `<ScrollView style={scrollStyle(maxH)}/>`. Opts in to the thin
 * scrollbar on web (Chrome 121+, Safari 18+, Firefox via
 * `scrollbarWidth`/`scrollbarColor`). On native the extra keys are ignored.
 *
 * Uses the theme-adaptive `text3` token for the scrollbar thumb so it remains
 * visible against both dark and light card surfaces (same pattern as
 * figma/shared.tsx).
 */
// biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
export function scrollStyle(maxHeight: number): any {
  const c = useColors();
  return {
    maxHeight,
    scrollbarWidth: 'thin',
    scrollbarColor: `${c.text3} transparent`,
  };
}

// =============================================================================
// Status mapping for primitives
// =============================================================================

export function toolStatusForPrimitive(status: ToolCallRendererProps['status']): McaStatusType {
  if (status === 'pending' || status === 'pending_permission') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return 'completed';
}

// =============================================================================
// GitHubToolShell — compose-only wrapper
// =============================================================================

export interface GitHubToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  description?: string;
  badge?: React.ReactNode;
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

/**
 * Pre-fills `iconUri={GITHUB_ICON}` and the description label. Composes
 * `ToolCallCard` only — does not introduce its own component logic.
 */
export function GitHubToolShell({
  toolName,
  status,
  duration,
  description,
  badge,
  defaultExpanded,
  children,
}: GitHubToolShellProps): React.ReactNode {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      verb={getToolLabel(toolName)}
      iconUri={GITHUB_ICON}
      badge={badge}
      defaultExpanded={defaultExpanded ?? false}
      animateExpand
    >
      {children}
    </ToolCallCard>
  );
}

export { Play, Star, Zap };
