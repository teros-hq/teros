import type { ToolConfig } from '@teros/mca-sdk';
import { getWsClient } from '../lib';
import { PROJECT_FIELDS } from './_fields';
import { assertBackendConnected, resolveFields, withTimeout } from './utils';

export const archiveProject: ToolConfig = {
  description:
    'Archive a project (soft-delete) and all its non-archived tasks. Only admin/owner can archive. Idempotent — if already archived, returns the project. Returns: { project: { ...PROJECT_FIELDS } }.',
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID to archive' },
      archiveNote: {
        type: 'string',
        description: 'Optional note explaining why the project was archived',
      },
      includeRaw: { type: 'boolean', description: 'Return full project document' },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    assertBackendConnected();
    const wsClient = getWsClient();
    const projectId = args?.projectId as string;
    if (!projectId) {
      throw new Error('projectId is required');
    }

    const actor = context?.execution?.agentId || 'unknown';

    const result = await withTimeout(
      wsClient.queryConversations<any>('archive_project', {
        projectId,
        archiveNote: args?.archiveNote,
        actor,
      }),
      15_000,
      'archive_project',
    );

    const project = resolveFields(result.project ?? {}, {
      includeRaw: args?.includeRaw === true,
      defaultFields: PROJECT_FIELDS,
    });
    return { project };
  },
};
