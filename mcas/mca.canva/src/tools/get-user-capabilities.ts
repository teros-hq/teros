import type { ToolConfig } from '@teros/mca-sdk';
import { buildUserCapabilitiesShape, canvaRequest } from '../lib';
import { USER_CAPABILITIES_FIELDS } from './_fields';
import { resolveFields, wrapCanvaCall } from './utils';

export const getUserCapabilities: ToolConfig = {
  description:
    'Get the authenticated user capabilities (Canva plan + role gating). Returns curated { capabilities: string[] }. Use to decide whether features like brand templates or autofill are available before calling them. Params: fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva capabilities response. Default false.' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { fields, includeRaw } = args as { fields?: string[]; includeRaw?: boolean };
    const raw = await wrapCanvaCall(() => canvaRequest(context, '/users/me/capabilities'));
    const shape = buildUserCapabilitiesShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: USER_CAPABILITIES_FIELDS,
    });
  },
};
