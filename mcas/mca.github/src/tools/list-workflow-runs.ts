import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertGitHubSegment, assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, curateRun, fieldPayload, pagedRequest } from '../lib/curate';

export const listWorkflowRuns: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List workflow runs for a repository. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      workflow_id: { type: 'string', description: 'Workflow ID or filename (optional)' },
      status: {
        type: 'string',
        enum: ['completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'in_progress', 'queued', 'requested', 'waiting'],
        description: 'Filter by status',
      },
      branch: { type: 'string', description: 'Only runs for this branch' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; workflow_id?: string; status?: string; branch?: string };
    assertOwnerRepo(a.owner, a.repo);
    assertGitHubSegment(a.workflow_id, 'workflow_id');
    const endpoint = a.workflow_id
      ? `/repos/${a.owner}/${a.repo}/actions/workflows/${a.workflow_id}/runs`
      : `/repos/${a.owner}/${a.repo}/actions/runs`;
    return pagedRequest(context, endpoint, a, { status: a.status, branch: a.branch }, fieldPayload('workflow_runs'), curateRun);
  },
};
