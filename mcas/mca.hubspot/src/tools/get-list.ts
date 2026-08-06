import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatList, LISTS_API } from '../lib';

export const getList: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a specific HubSpot list by ID (CRM Lists v3). Params: listId',
  parameters: {
    type: 'object',
    properties: {
      listId: { type: 'string', description: 'HubSpot list ID.' },
    },
    required: ['listId'],
  },
  handler: async (args, context) => {
    const { listId } = args as { listId: string | number };

    const data = (await hubspotRequest(
      context,
      `${LISTS_API}/${encodeURIComponent(String(listId))}`,
      // Request hs_list_size so formatList can populate memberCount (consistent
      // with list-lists); HubSpot ignores the param if unsupported on get-by-id.
      { params: { additionalProperties: 'hs_list_size' } },
    )) as any;

    // get-by-id wraps the list in { list: {...} }.
    return formatList(data.list ?? data);
  },
};
