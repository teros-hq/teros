import type { ToolConfig } from '@teros/mca-sdk';
import { buildFolderShape, canvaRequest } from '../lib';
import { FOLDER_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields } from './utils';

export const createFolder: ToolConfig = {
  description:
    'Create a new folder under a parent. Use parentFolderId="root" for top level. Returns curated folder. Not retryable. Params: name, parentFolderId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Folder name.' },
      parentFolderId: { type: 'string', description: 'Parent folder ID ("root" for top level).' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva folder response. Default false.' },
    },
    required: ['name', 'parentFolderId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { name, parentFolderId, fields, includeRaw } = args as {
      name: string;
      parentFolderId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(name, 'name');
    validateNonEmpty(parentFolderId, 'parentFolderId');

    const raw = await canvaRequest(context, '/folders', {
      method: 'POST',
      body: { name, parent_folder_id: parentFolderId },
    });
    const shape = buildFolderShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: FOLDER_FIELDS,
    });
  },
};
