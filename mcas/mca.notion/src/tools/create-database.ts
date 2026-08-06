import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { normaliseRelationSchema } from './_data-source-resolver';
import { DATABASE_DETAIL_FIELDS } from './_fields';
import { extractDatabaseShape, resolveNotionId } from './_notion-helpers';
import { resolveFields, wrapNotionWrite } from './utils';

export const createDatabase: ToolConfig = {
  description:
    'Create a new database as a child of a page. Returns curated { id, url, title, schema, icon, cover, createdTime, parentType, parentId }. Not retryable (no idempotency key).',
  parameters: {
    type: 'object',
    properties: {
      parentPageId: {
        type: 'string',
        description: 'Parent page UUID or its Notion URL (page share link).',
      },
      title: {
        type: 'string',
        description: 'Database title.',
      },
      properties: {
        type: 'object',
        description:
          'Notion schema. Ex: { Name: { title: {} }, Status: { select: { options: [...] } } }.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion database object. Default false.',
      },
    },
    required: ['parentPageId', 'title', 'properties'],
  },
  annotations: { readOnlyHint: false, version: '2.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      parentPageId: rawParentPageId,
      title,
      properties,
      fields,
      includeRaw,
    } = args as {
      parentPageId: string;
      title: string;
      properties: Record<string, any>;
      fields?: string[];
      includeRaw?: boolean;
    };
    const parentPageId = resolveNotionId(rawParentPageId, 'parentPageId');

    // Relation columns in the initial schema must reference a `data_source_id`
    // (API 2025-09-03+); agents still emit the legacy `database_id`. Normalise
    // before the call so create-database accepts the same shape the agent uses
    // elsewhere. Incident: TER-369.
    const resolvedProperties = await normaliseRelationSchema(client, properties);

    // API 2025-09-03 wraps the initial schema in an `initial_data_source`
    // envelope. The SDK still accepts the legacy `properties` key but
    // emits a deprecation warning, so we use the new shape.
    //
    // `parent.type` is REQUIRED on API 2026-03-11 — omitting it 400s with
    // `body.parent.type should be defined, instead was 'undefined'`. Incident:
    // TER-369 (s4).
    const raw: any = await wrapNotionWrite(() =>
      client.databases.create({
        parent: { type: 'page_id', page_id: parentPageId },
        title: [{ text: { content: title } }],
        initial_data_source: { properties: resolvedProperties },
      } as any),
    );

    const shape = extractDatabaseShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: DATABASE_DETAIL_FIELDS,
    });
  },
};
