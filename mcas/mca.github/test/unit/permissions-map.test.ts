import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  // Guard against the exact drift that broke create-repo in production
  // (audit task_f3dade883853eb86, 2026-10-01): permissions-map demanded
  // administration:write but manifest.json requested administration:read,
  // so every create-repo call 403'd with "Resource not accessible by
  // integration". aggregateRequiredPermissions() is documented as the
  // source of truth for the manifest permissions block — this test makes
  // that contract enforceable instead of aspirational.
  it('manifest.json auth.permissions satisfies every tool requirement (write wins)', () => {
    const manifestPath = join(import.meta.dir, '..', '..', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const manifestPermissions = manifest.layers.auth.permissions as Record<string, string>;
    const required = aggregateRequiredPermissions();

    const problems: string[] = [];
    for (const [key, level] of Object.entries(required)) {
      const manifestLevel = manifestPermissions[key];
      if (manifestLevel === undefined) {
        problems.push(`manifest.json is missing "${key}" (tools need ${key}:${level})`);
      } else if (manifestLevel !== level) {
        problems.push(
          `"${key}": manifest.json says ${manifestLevel} but tools need ${level} — ` +
            'GitHub will reject the affected tools with 403',
        );
      }
    }
    expect(problems).toEqual([]);
  });

  // Least-privilege guard (audit task_f3fade883853eb86 finding #3, fixed by
  // task_29157b443b409fa5, 2026-10-01): the manifest used to carry `workflows`
  // and `members` although aggregateRequiredPermissions() — the documented
  // source of truth for the manifest permissions block — showed no tool needs
  // them. Any permission key in the manifest that no tool requires is
  // over-scope and must fail here; add the tool that needs it or drop the key.
  it('manifest.json auth.permissions exactly matches the tools aggregate (no over-scope)', () => {
    const manifestPath = join(import.meta.dir, '..', '..', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const manifestPermissions = manifest.layers.auth.permissions as Record<string, string>;
    const required = aggregateRequiredPermissions();

    const overScoped = Object.keys(manifestPermissions).filter((key) => !(key in required));
    expect(overScoped).toEqual([]);
  });
});
