import type { ToolConfig } from '@teros/mca-sdk';
import { buildFolderShape, canvaRequest, type CanvaFolderShape } from '../lib';
import { FOLDER_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, sanitiseBody, wrapCanvaCall } from './utils';

export const updateFolder: ToolConfig = {
  description:
    'Rename a folder. Idempotent. Returns curated folder. Params: folderId, name, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: 'Canva folder ID.' },
      name: { type: 'string', description: 'New folder name.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva folder response. Default false.' },
    },
    required: ['folderId', 'name'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { folderId, name, fields, includeRaw } = args as {
      folderId: string;
      name: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(folderId, 'folderId');
    validateNonEmpty(name, 'name');

    const body = sanitiseBody({ name }, { stripNull: true });
    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/folders/${encodeURIComponent(folderId)}`, { method: 'PATCH', body }),
    );
    const shape: CanvaFolderShape = buildFolderShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: FOLDER_FIELDS,
    });
  },
};
