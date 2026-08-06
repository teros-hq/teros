import type { ToolConfig } from '@teros/mca-sdk';
import { buildAssetShape, canvaRequest, type CanvaAssetShape } from '../lib';
import { ASSET_DETAIL_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, sanitiseBody, wrapCanvaCall } from './utils';

export const updateAsset: ToolConfig = {
  description:
    'Update asset metadata (rename, retag). Idempotent — same payload yields same final state. Returns curated asset. Params: assetId, name?, tags?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'Canva asset ID.' },
      name: { type: 'string', description: 'New display name.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace tags wholesale (Canva PATCH semantics).',
      },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva asset response. Default false.' },
    },
    required: ['assetId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { assetId, name, tags, fields, includeRaw } = args as {
      assetId: string;
      name?: string;
      tags?: string[];
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(assetId, 'assetId');

    const body = sanitiseBody({ name, tags }, { stripNull: true });
    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/assets/${encodeURIComponent(assetId)}`, { method: 'PATCH', body }),
    );
    const shape: CanvaAssetShape = buildAssetShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: ASSET_DETAIL_FIELDS,
    });
  },
};
