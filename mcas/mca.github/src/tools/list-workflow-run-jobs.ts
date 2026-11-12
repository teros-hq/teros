import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, fieldPayload, curateJob, pagedRequest } from '../lib/curate';

export const listWorkflowRunJobs: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List the jobs (and their steps) of a workflow run. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      run_id: { type: 'number', description: 'Workflow run id' },
      filter: { type: 'string', enum: ['latest', 'all'], description: 'Filter by attempt (default: latest)' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo', 'run_id'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string; run_id: number; filter?: string };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/actions/runs/${a.run_id}/jobs`, a, { filter: a.filter }, fieldPayload('jobs'), curateJob);
  },
};
