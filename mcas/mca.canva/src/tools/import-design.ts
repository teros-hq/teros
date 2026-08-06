import type { ToolConfig } from '@teros/mca-sdk';
import { buildImportJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateExternalUrl, validateNonEmpty } from './_validate';
import { resolveFields, sanitiseBody } from './utils';

export const importDesign: ToolConfig = {
  description:
    'Import an external file (e.g. PDF, PPTX, DOCX) as a new Canva design. Async — returns curated job (poll get-import-job by id). url must be http/https. Not retryable. Params: title, url, mimeType?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title for the imported design.' },
      url: { type: 'string', description: 'Publicly accessible http/https URL of the source file.' },
      mimeType: { type: 'string', description: 'Optional MIME type override.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['title', 'url'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { title, url, mimeType, fields, includeRaw } = args as {
      title: string;
      url: string;
      mimeType?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(title, 'title');
    validateExternalUrl(url, 'url');

    const body = sanitiseBody({ title, url, mime_type: mimeType });
    const raw = await canvaRequest(context, '/url-imports', { method: 'POST', body });
    const shape = buildImportJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
