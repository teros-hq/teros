import type { ToolConfig } from '@teros/mca-sdk';
import { buildImportJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getImportJob: ToolConfig = {
  description:
    'Get a URL design import job status/result. Returns curated job { id, status, error, result.designId? }. Params: jobId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job ID returned by import-design.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['jobId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { jobId, fields, includeRaw } = args as {
      jobId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(jobId, 'jobId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/url-imports/${encodeURIComponent(jobId)}`),
    );
    const shape = buildImportJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
