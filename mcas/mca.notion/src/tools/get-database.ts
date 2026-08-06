import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { resolveDataSourceId } from './_data-source-resolver';
import { DATABASE_DETAIL_FIELDS } from './_fields';
import { extractDatabaseShape, resolveNotionId } from './_notion-helpers';
import { getSchema } from './_schema-cache';
import { resolveFields, wrapNotionCall } from './utils';

export const getDatabase: ToolConfig = {
  description:
    'Retrieve a database. Returns curated { id, url, title, description, icon, cover, schema, createdTime, lastEditedTime, parentType, parentId, archived }. Params: databaseId, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'Database UUID or its Notion URL (the table link).',
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
    required: ['databaseId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      databaseId: rawDatabaseId,
      fields,
      includeRaw,
    } = args as {
      databaseId: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    const databaseId = resolveNotionId(rawDatabaseId, 'databaseId');

    const raw: any = await wrapNotionCall(() =>
      client.databases.retrieve({ database_id: databaseId }),
    );
    // Notion API 2025-09-03 split the database object into a "container" + N
    // data sources. `databases.retrieve` no longer returns `properties` —
    // those live on the data source. Synthesise a `properties` map by joining
    // the schema of the first data source so the curated `schema` field is
    // populated for single-source DBs (the common case).
    if (!raw.properties) {
      try {
        const schema = await getSchema(client, databaseId);
        raw.properties = Object.fromEntries(
          Object.entries(schema).map(([key, meta]) => [
            key,
            { type: meta.type, name: meta.name ?? key },
          ]),
        );
      } catch {
        // Multi-source DBs or temporary failures fall through to schema: {}.
        // The agent can still reach properties via dataSources.retrieve.
      }
    }
    const shape = extractDatabaseShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: DATABASE_DETAIL_FIELDS,
    });
  },
};
