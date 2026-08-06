import type { ToolConfig } from '@teros/mca-sdk';
import { buildUserShape, canvaRequest } from '../lib';
import { USER_FIELDS } from './_fields';
import { resolveFields, wrapCanvaCall } from './utils';

export const getUser: ToolConfig = {
  description:
    'Get the authenticated Canva user. Returns curated { userId, teamId }. Params: fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva /users/me response. Default false.' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { fields, includeRaw } = args as { fields?: string[]; includeRaw?: boolean };
    const raw = await wrapCanvaCall(() => canvaRequest(context, '/users/me'));
    const shape = buildUserShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: USER_FIELDS });
  },
};
