import type { ToolConfig } from '@teros/mca-sdk';
import { buildExportFormatsShape, canvaRequest } from '../lib';
import { EXPORT_FORMATS_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getDesignExportFormats: ToolConfig = {
  description:
    'List the export formats supported by a specific design. Use this before export-design to avoid 400 errors on unsupported formats. Returns curated { formats: string[] }. Params: designId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva formats response. Default false.' },
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
      canvaRequest(context, `/designs/${encodeURIComponent(designId)}/export-formats`),
    );
    const shape = buildExportFormatsShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: EXPORT_FORMATS_FIELDS,
    });
  },
};
