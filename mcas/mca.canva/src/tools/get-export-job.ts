import type { ToolConfig } from '@teros/mca-sdk';
import { buildExportJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getExportJob: ToolConfig = {
  description:
    'Get an export job status/result. Returns curated job { id, status, error, result.urls? }. Params: exportId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      exportId: { type: 'string', description: 'Export job ID returned by export-design.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['exportId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { exportId, fields, includeRaw } = args as {
      exportId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(exportId, 'exportId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/exports/${encodeURIComponent(exportId)}`),
    );
    const shape = buildExportJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
