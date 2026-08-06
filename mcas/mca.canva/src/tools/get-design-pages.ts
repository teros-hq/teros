import type { ToolConfig } from '@teros/mca-sdk';
import { buildDesignPagesShape, canvaRequest } from '../lib';
import { DESIGN_PAGES_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getDesignPages: ToolConfig = {
  description:
    'Get pages of a Canva design with thumbnails (returns dimensions for bounded designs). Returns curated { pages: [{ index, thumbnailUrl, width, height }] }. Params: designId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva pages response. Default false.' },
    },
    required: ['designId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { designId, fields, includeRaw } = args as {
      designId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/designs/${encodeURIComponent(designId)}/pages`),
    );
    const shape = buildDesignPagesShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: DESIGN_PAGES_FIELDS,
    });
  },
};
