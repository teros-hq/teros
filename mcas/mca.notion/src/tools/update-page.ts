import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { buildPropertiesFromSimple } from './_build-property-value';
import { PAGE_DETAIL_FIELDS } from './_fields';
import { extractPageShape, resolveNotionId } from './_notion-helpers';
import { withSchemaCache } from './_schema-cache';
import { resolveFields, wrapNotionCall } from './utils';

export const updatePage: ToolConfig = {
  description:
    'Update page properties and/or archive state. Returns the curated updated page { id, url, title, properties, icon, cover, archived, lastEditedTime }. Idempotent per-field — retries are safe.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page UUID.',
      },
      properties: {
        type: 'object',
        description: 'Notion properties object to update (depends on database schema). Used as-is.',
      },
      propertiesSimple: {
        type: 'object',
        description:
          "Agent-friendly flat map: `{ Status: 'Done' }`. Schema is resolved automatically. Database rows only. If both `properties` and `propertiesSimple` are passed, raw `properties` wins.",
      },
      archived: {
        type: 'boolean',
        description:
          'Move to trash (true) or restore (false). Sent as `in_trash` per API 2026-03-11. Optional.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on the returned page.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion page object. Default false.',
      },
    },
    required: ['pageId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      pageId: rawPageId,
      properties,
      propertiesSimple,
      archived,
      fields,
      includeRaw,
    } = args as {
      pageId: string;
      properties?: Record<string, any>;
      propertiesSimple?: Record<string, unknown>;
      archived?: boolean;
      fields?: string[];
      includeRaw?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');

    const updateParams: any = { page_id: pageId };
    if (properties && Object.keys(properties).length > 0) {
      if (propertiesSimple) {
        // eslint-disable-next-line no-console
        console.warn(
          '[mca.notion] update-page: both `properties` and `propertiesSimple` supplied — using raw `properties`.',
        );
      }
      updateParams.properties = properties;
    } else if (propertiesSimple) {
      const page: any = await wrapNotionCall(() => client.pages.retrieve({ page_id: pageId }));
      const parentType = page?.parent?.type;
      const databaseId =
        parentType === 'database_id' || parentType === 'data_source_id'
          ? (page.parent.database_id ?? null)
          : null;
      if (!databaseId) {
        throw new Error(
          'propertiesSimple requires the page to live under a database. Use `properties` (raw) for non-database pages.',
        );
      }
      updateParams.properties = await withSchemaCache(client, databaseId, async (schema) =>
        buildPropertiesFromSimple(schema, propertiesSimple),
      );
    }
    if (archived !== undefined) updateParams.in_trash = archived;

    const raw: any = await client.pages.update(updateParams);
    const shape = extractPageShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: PAGE_DETAIL_FIELDS,
    });
  },
};
