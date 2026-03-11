import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const listTags: ToolConfig = {
  description: 'List all tags defined in the Intercom workspace. Useful for finding tag IDs before tagging conversations.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const result = (await intercomRequest(context, '/tags')) as Record<string, unknown>;
    const tags = (result.data as any[]) ?? [];
    return {
      count: tags.length,
      tags: tags.map((t) => ({ id: t.id, name: t.name })),
    };
  },
};
