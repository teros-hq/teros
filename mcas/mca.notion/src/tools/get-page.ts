import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { PAGE_DETAIL_FIELDS } from './_fields';
import { extractPageShape, resolveNotionId } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const getPage: ToolConfig = {
  description:
    'Retrieve a page. Returns curated { id, url, title, icon, cover, properties, createdTime, lastEditedTime, parentType, parentId, archived }. Params: pageId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page UUID (with or without dashes).',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion page object. Default false.',
      },
    },
    required: ['pageId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      pageId: rawPageId,
      fields,
      includeRaw,
    } = args as {
      pageId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');

    const raw: any = await wrapNotionCall(() => client.pages.retrieve({ page_id: pageId }));
    const shape = extractPageShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PAGE_DETAIL_FIELDS,
    });
  },
};
