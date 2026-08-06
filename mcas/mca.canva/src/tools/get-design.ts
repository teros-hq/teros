import type { ToolConfig } from '@teros/mca-sdk';
import { buildDesignShape, canvaRequest } from '../lib';
import { DESIGN_DETAIL_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getDesign: ToolConfig = {
  description:
    'Get a Canva design by ID. Returns curated detail (id, title, ownerUserId/teamId, thumbnail*, edit/view URLs, pageCount, dates). Params: designId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva design response. Default false.' },
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
      canvaRequest(context, `/designs/${encodeURIComponent(designId)}`),
    );
    const shape = buildDesignShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: DESIGN_DETAIL_FIELDS,
    });
  },
};
