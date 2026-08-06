import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { PAGE_COMPACT_FIELDS } from './_fields';
import { extractPageShape, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const setPageCover: ToolConfig = {
  description:
    "Set a page's cover image from an external URL. Returns curated { id, url, title, cover, lastEditedTime }. Idempotent.",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page UUID.',
      },
      coverUrl: {
        type: 'string',
        description: 'HTTPS URL of the cover image.',
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
    required: ['pageId', 'coverUrl'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId, coverUrl, fields, includeRaw } = args as {
      pageId: string;
      coverUrl: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(pageId, 'pageId');

    const raw: any = await wrapNotionCall(() =>
      client.pages.update({
        page_id: pageId,
        cover: { type: 'external', external: { url: coverUrl } } as any,
      }),
    );
    const shape = extractPageShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PAGE_COMPACT_FIELDS,
    });
  },
};
