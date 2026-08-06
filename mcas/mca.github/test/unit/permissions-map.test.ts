import { describe, expect, it } from 'bun:test';

import {
  TOOL_PERMISSIONS,
  aggregateRequiredPermissions,
  getRequiredPermissions,
} from '../../src/lib/permissions-map';

describe('TOOL_PERMISSIONS mapping', () => {
  it('covers every registered tool', () => {
    // Every tool registered in src/index.ts MUST have a permissions entry.
    // This guards against drift between handler registration and the
    // permissions map (criterion 17 + permission widget contract).
    const required = [
      '-health-check',
      'list-repos', 'get-repo', 'create-repo', 'search-repos',
      'list-issues', 'get-issue', 'create-issue', 'update-issue', 'add-issue-comment',
      'add-labels-to-issue', 'search-issues',
      'list-pulls', 'get-pull', 'create-pull', 'merge-pull',
      'list-pr-files', 'list-pr-commits', 'list-pr-review-comments',
      'request-reviewers', 'create-pr-review',
      'list-branches', 'get-branch', 'create-branch',
      'list-commits', 'get-commit', 'compare-commits',
      'list-workflows', 'list-workflow-runs', 'get-workflow-run',
      'list-workflow-run-jobs', 'trigger-workflow',
      'rerun-workflow-run', 'cancel-workflow-run',
      'list-releases', 'create-release',
      'get-file-content', 'create-or-update-file',
      'search-code',
      'get-installation-context', 'clone-repo',
      'create-check-run', 'update-check-run',
      'get-rate-limit', 'dispatch-event',
    ];
    for (const tool of required) {
      expect(TOOL_PERMISSIONS[tool]).toBeDefined();
    }
  });

  it('write tools require write permission level', () => {
    expect(TOOL_PERMISSIONS['merge-pull']?.pull_requests).toBe('write');
    expect(TOOL_PERMISSIONS['merge-pull']?.contents).toBe('write');
    expect(TOOL_PERMISSIONS['create-or-update-file']?.contents).toBe('write');
    expect(TOOL_PERMISSIONS['trigger-workflow']?.actions).toBe('write');
    expect(TOOL_PERMISSIONS['rerun-workflow-run']?.actions).toBe('write');
    expect(TOOL_PERMISSIONS['cancel-workflow-run']?.actions).toBe('write');
    expect(TOOL_PERMISSIONS['add-labels-to-issue']?.issues).toBe('write');
    expect(TOOL_PERMISSIONS['create-issue']?.issues).toBe('write');
    expect(TOOL_PERMISSIONS['create-check-run']?.checks).toBe('write');
    expect(TOOL_PERMISSIONS['update-check-run']?.checks).toBe('write');
    expect(TOOL_PERMISSIONS['dispatch-event']?.contents).toBe('write');
  });

  it('read tools never require write', () => {
    const readTools = [
      'list-repos', 'get-repo', 'list-issues', 'get-issue', 'list-pulls',
      'get-pull', 'list-pr-files', 'list-pr-commits', 'list-branches',
      'get-branch', 'list-commits', 'get-commit', 'compare-commits',
      'list-workflows', 'list-workflow-runs', 'get-workflow-run',
      'list-workflow-run-jobs', 'list-releases', 'get-file-content',
      'search-repos', 'search-code', 'search-issues', 'list-pr-review-comments',
      'get-installation-context', '-health-check',
    ];
    for (const tool of readTools) {
      const perms = TOOL_PERMISSIONS[tool] ?? {};
      for (const level of Object.values(perms)) {
        expect(level).toBe('read');
      }
    }
  });

  it('aggregates required permissions across all tools — write wins', () => {
    const agg = aggregateRequiredPermissions();
    expect(agg.contents).toBe('write');
    expect(agg.issues).toBe('write');
    expect(agg.pull_requests).toBe('write');
    expect(agg.actions).toBe('write');
    expect(agg.metadata).toBe('read');
  });

  it('getRequiredPermissions returns null for unknown tool', () => {
    expect(getRequiredPermissions('not-a-tool')).toBeNull();
  });
});
