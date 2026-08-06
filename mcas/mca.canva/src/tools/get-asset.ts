import type { ToolConfig } from '@teros/mca-sdk';
import { buildAssetShape, canvaRequest } from '../lib';
import { ASSET_DETAIL_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields, wrapCanvaCall } from './utils';

export const getAsset: ToolConfig = {
  description:
    'Get asset metadata. Returns curated { id, name, type, thumbnail*, tags, metadata, dates }. Params: assetId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      assetId: { type: 'string', description: 'Canva asset ID.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva asset response. Default false.' },
    },
    required: ['assetId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { assetId, fields, includeRaw } = args as {
      assetId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(assetId, 'assetId');

    const raw = await wrapCanvaCall(() =>
      canvaRequest(context, `/assets/${encodeURIComponent(assetId)}`),
    );
    const shape = buildAssetShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: ASSET_DETAIL_FIELDS,
    });
  },
};
