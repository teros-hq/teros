import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { PAGE_COMPACT_FIELDS } from './_fields';
import { extractPageShape, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const setPageIcon: ToolConfig = {
  description:
    "Set a page's icon (emoji or external URL). Returns curated { id, url, title, icon, lastEditedTime }. Idempotent.",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page UUID.',
      },
      iconType: {
        type: 'string',
        description: "'emoji' or 'external'.",
        enum: ['emoji', 'external'],
      },
      icon: {
        type: 'string',
        description: 'Emoji character or image URL depending on iconType.',
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
    required: ['pageId', 'iconType', 'icon'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId, iconType, icon, fields, includeRaw } = args as {
      pageId: string;
      iconType: 'emoji' | 'external';
      icon: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(pageId, 'pageId');

    const iconObj =
      iconType === 'emoji'
        ? { type: 'emoji', emoji: icon }
        : { type: 'external', external: { url: icon } };

    const raw: any = await wrapNotionCall(() =>
      client.pages.update({
        page_id: pageId,
        icon: iconObj as any,
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
