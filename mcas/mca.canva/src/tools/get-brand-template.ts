import type { ToolConfig } from '@teros/mca-sdk';
import { buildBrandTemplateShape, canvaRequest } from '../lib';
import { BRAND_TEMPLATE_DETAIL_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getBrandTemplate: ToolConfig = {
  description:
    'Get brand template metadata. Returns curated detail (id, title, thumbnailUrl, viewUrl, createUrl, dates). Params: brandTemplateId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      brandTemplateId: { type: 'string', description: 'Canva brand template ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva response. Default false.' },
    },
    required: ['brandTemplateId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { brandTemplateId, fields, includeRaw } = args as {
      brandTemplateId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(brandTemplateId, 'brandTemplateId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/brand-templates/${encodeURIComponent(brandTemplateId)}`),
    );
    const shape = buildBrandTemplateShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: BRAND_TEMPLATE_DETAIL_FIELDS,
    });
  },
};
