import type { ToolConfig } from '@teros/mca-sdk';
import { buildAssetUploadJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateExternalUrl, validateNonEmpty } from './_validate';
import { resolveFields } from './utils';

export const uploadAsset: ToolConfig = {
  description:
    'Upload an asset (image, video, audio) to the user library from a public URL. Async — returns curated job (poll get-asset-upload-job by id). url must be http/https. Not retryable. Params: name, url, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name for the new asset.' },
      url: { type: 'string', description: 'Publicly accessible http/https URL of the file.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['name', 'url'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { name, url, fields, includeRaw } = args as {
      name: string;
      url: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(name, 'name');
    validateExternalUrl(url, 'url');

    const raw = await canvaRequest(context, '/url-asset-uploads', {
      method: 'POST',
      body: { name, url },
    });
    const shape = buildAssetUploadJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
