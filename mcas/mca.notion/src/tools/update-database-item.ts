import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { buildPropertiesFromSimple } from './_build-property-value';
import { PAGE_DETAIL_FIELDS } from './_fields';
import { extractPageShape, resolveNotionId } from './_notion-helpers';
import { withSchemaCache } from './_schema-cache';
import { resolveFields, wrapNotionCall } from './utils';

export const updateDatabaseItem: ToolConfig = {
  description:
    'Update an existing row (record) in a Notion database. Update row, modify record, change relation, set assignee, mark as done. Pass `pageId` and `properties` as a flat agent-friendly map: `{ Status: "Done", Assignee: ["<uuid>"] }`. The handler resolves the schema from the parent database and serialises each value automatically. Pass `archived: true` to move to trash. Idempotent — safe to retry. For multi-source DBs the `databaseId` of the row is read off the page parent.',
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Database row (page) UUID.' },
      properties: {
        type: 'object',
        description: 'Flat map of column name → simple value to update.',
      },
      archived: {
        type: 'boolean',
        description: 'Move to Notion trash (true) or restore (false). Sent as `in_trash`.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned page.',
      },
      includeRaw: { type: 'boolean', description: 'Return raw Notion page object. Default false.' },
    },
    required: ['pageId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental', idempotentHint: true },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      pageId: rawPageId,
      properties,
      archived,
      fields,
      includeRaw,
    } = args as {
      pageId: string;
      properties?: Record<string, unknown>;
      archived?: boolean;
      fields?: string[];
      includeRaw?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');

    let serialised: Record<string, unknown> | undefined;
    if (properties && Object.keys(properties).length > 0) {
      // Look up the page to find its parent database, then serialise the
      // simple values against that schema.
      const page: any = await wrapNotionCall(() => client.pages.retrieve({ page_id: pageId }));
      const parentType = page?.parent?.type;
      let databaseId: string | null = null;
      if (parentType === 'database_id') databaseId = page.parent.database_id ?? null;
      else if (parentType === 'data_source_id') databaseId = page.parent.database_id ?? null;
      if (!databaseId) {
        throw new Error(
          'updateDatabaseItem requires the page to live under a database. ' +
            'Use update-page for non-database pages.',
        );
      }

      serialised = await withSchemaCache(client, databaseId, async (schema) =>
        buildPropertiesFromSimple(schema, properties),
      );
    }

    const updateParams: Record<string, unknown> = { page_id: pageId };
    if (serialised) updateParams.properties = serialised;
    if (archived !== undefined) updateParams.in_trash = archived;

    const raw: any = await client.pages.update(updateParams as any);
    const shape = extractPageShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PAGE_DETAIL_FIELDS,
    });
  },
};
