import type { ToolConfig } from '@teros/mca-sdk';
import { canvaRequest } from '../lib';
import { validateNonEmpty } from './_validate';
import { wrapCanvaCall } from './utils';

export const getBrandTemplateDataset: ToolConfig = {
  description:
    'Get the autofill dataset (named fields like {title}, {body}, {image}) for a brand template. Returned shape mirrors Canva — useful before calling autofill-design. Params: brandTemplateId.',
  parameters: {
    type: 'object',
    properties: {
      brandTemplateId: { type: 'string', description: 'Canva brand template ID.' },
    },
    required: ['brandTemplateId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { brandTemplateId } = args as { brandTemplateId: string };
    validateNonEmpty(brandTemplateId, 'brandTemplateId');
    return wrapCanvaCall(() =>
      canvaRequest(context, `/brand-templates/${encodeURIComponent(brandTemplateId)}/dataset`),
    );
  },
};
