import type { ToolConfig } from '@teros/mca-sdk';
import { buildFolderItemShape, canvaRequest } from '../lib';
import { FOLDER_ITEM_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFieldsList, sanitizeLimit, wrapCanvaCall } from './utils';

export const listFolders: ToolConfig = {
  description:
    'List items in a folder (designs, sub-folders, images, videos). Use folderId="root" for top level. Returns curated rows with thumbnail URL. Params: folderId, itemTypes?, sortBy?, pinStatus? (pinned|unpinned), limit (1-100, def 50), continuation?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      folderId: { type: 'string', description: "Folder ID ('root' for top-level)." },
      itemTypes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter by type (e.g. ["design", "image", "video", "folder"]).',
      },
      sortBy: { type: 'string', description: 'e.g. modified_descending, title_ascending.' },
      pinStatus: {
        type: 'string',
        enum: ['pinned', 'unpinned'],
        description: 'Filter pinned items.',
      },
      limit: { type: 'number', description: 'Max results. Min 1, max 100, default 50.' },
      continuation: { type: 'string', description: 'Pagination token.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva response. Default false.' },
    },
    required: ['folderId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { folderId, itemTypes, sortBy, pinStatus, limit, continuation, fields, includeRaw } =
      args as {
        folderId: string;
        itemTypes?: string[];
        sortBy?: string;
        pinStatus?: string;
        limit?: number;
        continuation?: string;
        fields?: string[];
        includeRaw?: boolean;
      };
    validateNonEmpty(folderId, 'folderId');

    const params = new URLSearchParams();
    if (itemTypes && itemTypes.length > 0) params.append('item_types', itemTypes.join(','));
    if (sortBy) params.append('sort_by', sortBy);
    if (pinStatus) params.append('pin_status', pinStatus);
    params.append('limit', String(sanitizeLimit(limit, { max: 100, default: 50 })));
    if (continuation) params.append('continuation', continuation);

    const raw: any = await wrapCanvaCall(() =>
      canvaRequest(
        context,
        `/folders/${encodeURIComponent(folderId)}/items?${params.toString()}`,
      ),
    );
    const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
    const shaped = items.map((it) => buildFolderItemShape(it));
    const out = resolveFieldsList(shaped as any[], items, {
      includeRaw,
      fields,
      defaultFields: FOLDER_ITEM_FIELDS,
    });

    return {
      folderId,
      items: out,
      total: out.length,
      hasMore: !!raw?.continuation,
      nextCursor: raw?.continuation ?? null,
    };
  },
};
