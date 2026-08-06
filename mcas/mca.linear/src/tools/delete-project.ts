import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { validateUuid } from './_linear-helpers';

export const deleteProject: ToolConfig = {
  description:
    'Permanently delete a Linear project. Irreversible. Issues in the project become detached (not deleted). Returns { success, projectId }.',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project UUID.' },
    },
    required: ['projectId'],
  },
  annotations: { version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { projectId } = args as { projectId: string };
    validateUuid(projectId, 'projectId');

    const result = await client.deleteProject(projectId);
    return { success: !!result.success, projectId };
  },
};
