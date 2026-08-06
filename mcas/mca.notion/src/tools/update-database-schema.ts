import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import {
  invalidateDataSourceCache,
  normaliseRelationSchema,
  resolveDataSourceId,
} from './_data-source-resolver';
import { DATABASE_DETAIL_FIELDS } from './_fields';
import { extractDatabaseShape, resolveNotionId } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const updateDatabaseSchema: ToolConfig = {
  description:
    'Add/modify/remove database columns and optionally rename. Schema mutations target the data source (Notion API 2025-09-03 split). Pass `dataSourceId` for multi-source DBs; otherwise the first one is used. Set a property value to `null` to remove it. Relation columns: pass `{ relation: { database_id: <id-or-url> } }` — the data_source_id and single_property envelope are resolved server-side. Returns the curated updated database { id, schema, title, description, lastEditedTime }. Idempotent per-field.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'Database UUID or its Notion URL (the table link with ?v=…).',
      },
      dataSourceId: {
        type: 'string',
        description: 'Specific data source UUID for multi-source DBs.',
      },
      properties: {
        type: 'object',
        description: 'Properties to add/modify. Set value to null to remove.',
      },
      title: {
        type: 'string',
        description: 'New title. Optional. Sent on the data source.',
      },
      description: {
        type: 'string',
        description: 'New description. Optional. Sent on the data source.',
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
    required: ['databaseId', 'properties'],
  },
  annotations: { readOnlyHint: false, version: '2.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      databaseId: rawDatabaseId,
      dataSourceId: rawDataSourceId,
      properties,
      title,
      description,
      fields,
      includeRaw,
    } = args as {
      databaseId: string;
      dataSourceId?: string;
      properties: Record<string, any>;
      title?: string;
      description?: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    const databaseId = resolveNotionId(rawDatabaseId, 'databaseId');
    const dataSourceId = rawDataSourceId
      ? resolveNotionId(rawDataSourceId, 'dataSourceId')
      : undefined;

    const resolvedDataSourceId = dataSourceId ?? (await resolveDataSourceId(client, databaseId));

    // Relation columns arrive with the legacy `relation.database_id`; the
    // data-source API requires `relation.data_source_id`. Normalise before the
    // update. Incident: TER-369 (s6).
    const resolvedProperties = await normaliseRelationSchema(client, properties);

    const updateParams: any = {
      data_source_id: resolvedDataSourceId,
      properties: resolvedProperties,
    };
    if (title) updateParams.title = [{ text: { content: title } }];
    if (description) updateParams.description = [{ text: { content: description } }];

    await wrapNotionCall(() => (client as any).dataSources.update(updateParams));

    // After mutating the schema we still want to return a curated *database*
    // shape (callers think in terms of databases). Re-fetch the database so
    // the response reflects the new schema joined back onto the database
    // attributes.
    const raw: any = await wrapNotionCall(() =>
      client.databases.retrieve({ database_id: databaseId }),
    );
    invalidateDataSourceCache(databaseId);
    const shape = extractDatabaseShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: DATABASE_DETAIL_FIELDS,
    });
  },
};
