import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatPipeline } from '../lib';

export const listPipelines: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot pipelines for deals or tickets. Returns pipeline definitions with stages. Params: objectType (deals or tickets), includeInactive?',
  parameters: {
    type: 'object',
    properties: {
      objectType: {
        type: 'string',
        description: 'Pipeline object type.',
        enum: ['deals', 'tickets'],
      },
      includeInactive: {
        type: 'boolean',
        description: 'Include inactive pipelines. Default false.',
      },
    },
    required: ['objectType'],
  },
  handler: async (args, context) => {
    const { objectType, includeInactive = false } = args as {
      objectType: 'deals' | 'tickets';
      includeInactive?: boolean;
    };

    const data = (await hubspotRequest(
      context,
      `/crm/v3/pipelines/${objectType}`,
      { params: includeInactive ? { includeInactive: 'true' } : undefined },
    )) as any;

    return {
      pipelines: (data.results ?? []).map(formatPipeline),
      total: data.results?.length ?? 0,
    };
  },
};
