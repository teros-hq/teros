import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatPipeline } from '../lib';

export const getPipeline: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a specific HubSpot pipeline by ID. Returns pipeline with stages. Params: objectType, pipelineId',
  parameters: {
    type: 'object',
    properties: {
      objectType: {
        type: 'string',
        description: 'Pipeline object type.',
        enum: ['deals', 'tickets'],
      },
      pipelineId: { type: 'string', description: 'Pipeline ID.' },
    },
    required: ['objectType', 'pipelineId'],
  },
  handler: async (args, context) => {
    const { objectType, pipelineId } = args as {
      objectType: 'deals' | 'tickets';
      pipelineId: string;
    };

    const data = (await hubspotRequest(
      context,
      `/crm/v3/pipelines/${objectType}/${encodeURIComponent(pipelineId)}`,
    )) as any;

    return formatPipeline(data);
  },
};
