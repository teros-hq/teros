import type { ToolConfig } from '@teros/mca-sdk';

export const catalogList: ToolConfig = {
  description: 'List all MCAs available in the catalog.',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional: Filter by category',
      },
      includeHidden: {
        type: 'boolean',
        description: 'Include hidden MCAs (default: false)',
      },
    },
  },
  handler: async (args, context) => {
    return context.catalogList(
      args.category as string | undefined,
      args.includeHidden as boolean | undefined,
    );
  },
};
