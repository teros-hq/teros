import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo } from '../lib';
import { PAGE_PARAMS, PAGED_RESULT_NOTE, type PageArgs, fieldPayload, curateWorkflow, pagedRequest } from '../lib/curate';

export const listWorkflows: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: `List GitHub Actions workflows of a repository. ${PAGED_RESULT_NOTE}`,
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      ...PAGE_PARAMS,
    },
    required: ['owner', 'repo'],
  },
  handler: async (args, context) => {
    const a = args as PageArgs & { owner: string; repo: string };
    assertOwnerRepo(a.owner, a.repo);
    return pagedRequest(context, `/repos/${a.owner}/${a.repo}/actions/workflows`, a, {}, fieldPayload('workflows'), curateWorkflow);
  },
};
