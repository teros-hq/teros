/**
 * Mapping of `mca.github` tools → required GitHub App permissions.
 *
 * Used by:
 *  - Audits (verify the App's registered permissions match what the tools
 *    actually need).
 *  - Documentation (each tool description can surface the required permission).
 *  - Future dry-run validation: detect at handler entry that the
 *    installation lacks a required permission, and fail with
 *    `INSUFFICIENT_PERMISSIONS` before the call.
 *
 * Reference: https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps
 *
 * Note: `metadata: read` is granted automatically by GitHub when ANY repo
 * permission is requested, so it's listed everywhere implicitly. Tools that
 * need ONLY metadata still declare it explicitly for documentation.
 */

export type GitHubAppPermissionLevel = 'read' | 'write';

export type GitHubAppPermissionKey =
  | 'contents'
  | 'issues'
  | 'pull_requests'
  | 'metadata'
  | 'workflows'
  | 'actions'
  | 'members'
  | 'administration'
  | 'checks'
  | 'statuses'
  | 'rate_limit';

export type ToolPermissions = Partial<Record<GitHubAppPermissionKey, GitHubAppPermissionLevel>>;

export const TOOL_PERMISSIONS: Record<string, ToolPermissions> = {
  // -- Repos --
  'list-repos': { metadata: 'read' },
  'get-repo': { metadata: 'read' },
  'create-repo': { administration: 'write' },
  'search-repos': { metadata: 'read' },

  // -- Issues --
  'list-issues': { issues: 'read' },
  'get-issue': { issues: 'read' },
  'create-issue': { issues: 'write' },
  'update-issue': { issues: 'write' },
  'add-issue-comment': { issues: 'write' },
  'add-labels-to-issue': { issues: 'write' },
  'search-issues': { issues: 'read' },

  // -- Pull requests --
  'list-pulls': { pull_requests: 'read' },
  'get-pull': { pull_requests: 'read' },
  'create-pull': { pull_requests: 'write', contents: 'read' },
  'merge-pull': { pull_requests: 'write', contents: 'write' },
  'list-pr-files': { pull_requests: 'read' },
  'list-pr-commits': { pull_requests: 'read' },
  'list-pr-review-comments': { pull_requests: 'read' },
  'request-reviewers': { pull_requests: 'write' },
  'create-pr-review': { pull_requests: 'write' },

  // -- Branches --
  'list-branches': { contents: 'read' },
  'get-branch': { contents: 'read' },
  'create-branch': { contents: 'write' },

  // -- Commits --
  'list-commits': { contents: 'read' },
  'get-commit': { contents: 'read' },
  'compare-commits': { contents: 'read' },

  // -- Actions / workflows --
  'list-workflows': { actions: 'read' },
  'list-workflow-runs': { actions: 'read' },
  'get-workflow-run': { actions: 'read' },
  'list-workflow-run-jobs': { actions: 'read' },
  'trigger-workflow': { actions: 'write', contents: 'read' },
  'rerun-workflow-run': { actions: 'write' },
  'cancel-workflow-run': { actions: 'write' },

  // -- Releases --
  'list-releases': { contents: 'read' },
  'create-release': { contents: 'write' },

  // -- Files --
  'get-file-content': { contents: 'read' },
  'create-or-update-file': { contents: 'write' },

  // -- Search --
  'search-code': { metadata: 'read' },

  // -- Users / git ops --
  'get-installation-context': { metadata: 'read' },
  'clone-repo': { contents: 'read' },

  // -- Checks (App-only) --
  'create-check-run': { checks: 'write' },
  'update-check-run': { checks: 'write' },

  // -- Misc App utilities --
  'get-rate-limit': { metadata: 'read' },
  'dispatch-event': { contents: 'write' },

  // -- Health --
  '-health-check': { metadata: 'read' },
};

/**
 * Aggregate of all permissions used by any tool in this MCA. Useful for
 * generating the `permissions` block in `manifest.json` from a single
 * source of truth.
 */
export function aggregateRequiredPermissions(): Record<GitHubAppPermissionKey, GitHubAppPermissionLevel> {
  const out: Partial<Record<GitHubAppPermissionKey, GitHubAppPermissionLevel>> = {};
  for (const tool of Object.values(TOOL_PERMISSIONS)) {
    for (const [k, v] of Object.entries(tool) as Array<
      [GitHubAppPermissionKey, GitHubAppPermissionLevel]
    >) {
      // 'write' wins over 'read' when the same permission is needed at
      // different levels for different tools.
      if (out[k] === 'write' || v === 'write') {
        out[k] = 'write';
      } else {
        out[k] = 'read';
      }
    }
  }
  return out as Record<GitHubAppPermissionKey, GitHubAppPermissionLevel>;
}

export function getRequiredPermissions(toolName: string): ToolPermissions | null {
  return TOOL_PERMISSIONS[toolName] ?? null;
}
