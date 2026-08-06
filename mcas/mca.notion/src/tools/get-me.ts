import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { USER_FIELDS } from './_fields';
import { extractUserShape } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const getMe: ToolConfig = {
  description:
    'Return the bot user (this integration). Returns curated { id, name, type, avatarUrl, email, bot }. Params: fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion user. Default false.',
      },
    },
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { fields, includeRaw } = args as {
      fields?: string[];
      includeRaw?: boolean;
    };

    const raw: any = await wrapNotionCall(() => client.users.me({}));
    const shape = extractUserShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: USER_FIELDS,
    });
  },
};
