import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const createPage: ToolConfig = {
  description: 'Create a new page in a database or as a child of an existing page.',
  parameters: {
    type: 'object',
    properties: {
      parentId: {
        type: 'string',
        description: 'Parent page ID or database ID',
      },
      parentType: {
        type: 'string',
        description: "Type of parent: 'page' or 'database'",
        enum: ['page', 'database'],
      },
      title: {
        type: 'string',
        description: 'Page title (optional when properties object is provided for database pages)',
      },
      properties: {
        type: 'object',
        description:
          'Complete properties object for database pages (optional). When provided for database pages, this will be used as-is without modification.',
      },
    },
    required: ['parentId', 'parentType'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const {
      parentId,
      parentType,
      title,
      properties: customProperties,
    } = args as {
      parentId: string;
      parentType: 'page' | 'database';
      title?: string;
      properties?: Record<string, any>;
    };

    const parent = parentType === 'database' ? { database_id: parentId } : { page_id: parentId };

    let properties: any;

    if (parentType === 'database') {
      // If properties already provided, use them as-is
      if (customProperties && Object.keys(customProperties).length > 0) {
        properties = customProperties;
      } else {
        // Default: try common title property name
        properties = {
          Name: {
            title: [{ text: { content: title || 'Untitled' } }],
          },
        };
      }
    } else {
      // For page parent, use title property
      properties = {
        title: [{ text: { content: title || 'Untitled' } }],
      };
    }

    const page = await client.pages.create({
      parent,
      properties,
    } as any);

    return page;
  },
};
