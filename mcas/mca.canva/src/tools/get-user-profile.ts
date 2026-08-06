import type { ToolConfig } from '@teros/mca-sdk';
import { buildUserProfileShape, canvaRequest } from '../lib';
import { USER_PROFILE_FIELDS } from './_fields';
import { resolveFields, wrapCanvaCall } from './utils';

export const getUserProfile: ToolConfig = {
  description:
    "Get the authenticated user's profile. Returns curated { displayName }. Params: fields?, includeRaw.",
  parameters: {
    type: 'object',
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva profile response. Default false.' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { fields, includeRaw } = args as { fields?: string[]; includeRaw?: boolean };
    const raw = await wrapCanvaCall(() => canvaRequest(context, '/users/me/profile'));
    const shape = buildUserProfileShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: USER_PROFILE_FIELDS,
    });
  },
};
