import type { ToolConfig } from '@teros/mca-sdk';
import { buildFolderShape, canvaRequest } from '../lib';
import { FOLDER_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getFolder: ToolConfig = {
  description:
    'Get folder metadata. Returns curated { id, name, thumbnailUrl, dates }. Params: folderId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'Canva folder ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva folder response. Default false.' },
    },
    required: ['folderId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { folderId, fields, includeRaw } = args as {
      folderId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(folderId, 'folderId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/folders/${encodeURIComponent(folderId)}`),
    );
    const shape = buildFolderShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: FOLDER_FIELDS,
    });
  },
};
