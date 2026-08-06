import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatList, LISTS_API } from '../lib';

export const listLists: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot lists (CRM Lists v3). Returns curated rows { id, name, processingType, dynamic, objectTypeId, createdAt, updatedAt, memberCount }. Params: limit?, offset?, processingType?',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Results per page. Max 500, default 50.' },
      offset: { type: 'number', description: 'Pagination offset (default 0).' },
      processingType: {
        type: 'string',
        description: 'Filter by processing type.',
        enum: ['MANUAL', 'STATIC', 'DYNAMIC', 'SNAPSHOT'],
      },
    },
  },
  handler: async (args, context) => {
    const { limit = 50, offset = 0, processingType } = args as {
      limit?: number;
      offset?: number;
      processingType?: 'MANUAL' | 'STATIC' | 'DYNAMIC' | 'SNAPSHOT';
    };

    // CRM Lists v3 lists ALL lists via POST /search with an empty query.
    // additionalProperties pulls hs_list_size so memberCount is populated.
    const body = {
      query: '',
      additionalProperties: ['hs_list_size'],
      listIds: [],
      processingTypes: processingType ? [processingType] : [],
      count: Math.min(Math.max(limit, 1), 500),
      offset,
    };

    const data = (await hubspotRequest(context, `${LISTS_API}/search`, {
      method: 'POST',
      body,
    })) as any;

    const lists = (data.lists ?? []).map(formatList);
    return {
      lists,
      total: data.total ?? lists.length,
      offset: data.offset ?? offset,
      hasMore: data.hasMore ?? false,
    };
  },
};
