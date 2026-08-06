import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { buildPropertiesFromSimple } from './_build-property-value';
import { resolveDataSourceId } from './_data-source-resolver';
import { PAGE_DETAIL_FIELDS } from './_fields';
import { extractPageShape, resolveNotionId } from './_notion-helpers';
import { withSchemaCache } from './_schema-cache';
import { resolveFields, wrapNotionWrite } from './utils';

export const createDatabaseItem: ToolConfig = {
  description:
    'Insert a new row (record) into a Notion database. Add to table, create table item, append database row. Pass `properties` as a flat agent-friendly map: `{ Title: "Spec", Status: "In review", Tags: ["urgent"], Assignee: ["<user-uuid>"], DueDate: "2026-05-06" }`. The handler resolves the schema and serialises each value into Notion\'s verbose shape automatically. Returns the curated created page. Multi-source DBs: pass `dataSourceId` to target a specific source.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'Database UUID or its Notion URL (the table link).',
      },
      dataSourceId: {
        type: 'string',
        description: 'Specific data source UUID for multi-source DBs.',
      },
      properties: {
        type: 'object',
        description: 'Flat map of column name → simple value. Schema is resolved automatically.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned page.',
      },
      includeRaw: { type: 'boolean', description: 'Return raw Notion page object. Default false.' },
    },
    required: ['databaseId', 'properties'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      databaseId: rawDatabaseId,
      dataSourceId: rawDataSourceId,
      properties,
      fields,
      includeRaw,
    } = args as {
      databaseId: string;
      dataSourceId?: string;
      properties: Record<string, unknown>;
      fields?: string[];
      includeRaw?: boolean;
    };
    const databaseId = resolveNotionId(rawDatabaseId, 'databaseId');
    const dataSourceId = rawDataSourceId
      ? resolveNotionId(rawDataSourceId, 'dataSourceId')
      : undefined;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error('properties must be an object map of column → value.');
    }

    const resolvedDataSourceId = dataSourceId ?? (await resolveDataSourceId(client, databaseId));

    // wrap LIVES outside withSchemaCache so the cache's `validation_error`
    // drift-recovery path keeps working on the raw SDK error code; the wrap
    // only kicks in once the inner action gives up.
    const raw: any = await wrapNotionWrite(() =>
      withSchemaCache(client, databaseId, async (schema) => {
        const notionProperties = buildPropertiesFromSimple(schema, properties);
        return await client.pages.create({
          parent: { data_source_id: resolvedDataSourceId },
          properties: notionProperties,
        } as any);
      }),
    );

    const shape = extractPageShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PAGE_DETAIL_FIELDS,
    });
  },
};
