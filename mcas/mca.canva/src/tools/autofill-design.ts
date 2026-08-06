import type { ToolConfig } from '@teros/mca-sdk';
import { buildAutofillJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, sanitiseBody } from './utils';

export const autofillDesign: ToolConfig = {
  description:
    'Create a design by autofilling a brand template with named fields. data keys must match the template dataset (call get-brand-template-dataset first). columnConfigs: optional chart-data field definitions. Async — returns curated job (poll get-autofill-job). Not retryable. Params: brandTemplateId, data, title?, columnConfigs?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      brandTemplateId: { type: 'string', description: 'Canva brand template ID.' },
      title: { type: 'string', description: 'Title for the new design.' },
      data: {
        type: 'object',
        description: 'Field name → value object matching the template dataset.',
      },
      columnConfigs: {
        type: 'object',
        description:
          'Optional column configurations for chart fields (added 2026-03). Map field name → { type, ... }.',
      },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['brandTemplateId', 'data'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { brandTemplateId, title, data, columnConfigs, fields, includeRaw } = args as {
      brandTemplateId: string;
      title?: string;
      data: Record<string, unknown>;
      columnConfigs?: Record<string, unknown>;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(brandTemplateId, 'brandTemplateId');

    const body = sanitiseBody({
      brand_template_id: brandTemplateId,
      data,
      title,
      column_configs: columnConfigs,
    });
    const raw = await canvaRequest(context, '/autofills', { method: 'POST', body });
    const shape = buildAutofillJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
