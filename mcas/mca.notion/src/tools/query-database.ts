import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { resolveDataSourceId } from './_data-source-resolver';
import { PAGE_COMPACT_FIELDS } from './_fields';
import { extractPageShape, extractProperties, resolveNotionId } from './_notion-helpers';
import { resolveFieldsList, sanitizeLimit, wrapNotionCall } from './utils';

export const queryDatabase: ToolConfig = {
  description:
    "Query database rows with filter + sorts. Returns curated rows { id, url, title, icon, properties, lastEditedTime }. `properties` whitelist controls which columns travel (default: title only). Pass `dataSourceId` directly for multi-source DBs; otherwise the first data source is used. Filter accepts the standard Notion shape: { property, <type>: { <op>: <value> } } — single-value ops only (Notion v5 does NOT support equals_any). To match any of N values, compose with `or`: { or: [ { property: 'Status', status: { equals: 'Done' } }, { property: 'Status', status: { equals: 'In review' } } ] }. Params: databaseId | dataSourceId, filter?, sorts?, propertyNames?, limit (1-100, def 50), startCursor, fields?, includeRaw.",
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description:
          'Database UUID. The first data source under it is queried unless `dataSourceId` is set.',
      },
      dataSourceId: {
        type: 'string',
        description:
          'Specific data source UUID to query. Use for multi-source DBs (wikis, linked DBs).',
      },
      filter: {
        type: 'object',
        description:
          'Notion filter object. Compose multi-value via `or`/`and` arrays — Notion does not have equals_any.',
      },
      sorts: {
        type: 'array',
        items: { type: 'object' },
        description: 'Array of sort objects.',
      },
      propertyNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Whitelist of property names to include in each row. Default: only the title. Pass ['*'] to include all.",
      },
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 50.',
      },
      startCursor: {
        type: 'string',
        description: 'Notion pagination cursor.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist on each row envelope.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion API response. Default false.',
      },
    },
    required: [],
  },
  annotations: { readOnlyHint: true, version: '2.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      databaseId: rawDatabaseId,
      dataSourceId: rawDataSourceId,
      filter,
      sorts,
      propertyNames,
      limit,
      startCursor,
      fields,
      includeRaw,
    } = args as {
      databaseId?: string;
      dataSourceId?: string;
      filter?: any;
      sorts?: any[];
      propertyNames?: string[];
      limit?: number;
      startCursor?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    if (!rawDatabaseId && !rawDataSourceId) {
      throw new Error('query-database requires either databaseId or dataSourceId.');
    }
    const databaseId = rawDatabaseId ? resolveNotionId(rawDatabaseId, 'databaseId') : undefined;
    const dataSourceId = rawDataSourceId
      ? resolveNotionId(rawDataSourceId, 'dataSourceId')
      : undefined;

    const resolvedDataSourceId =
      dataSourceId ?? (await resolveDataSourceId(client, databaseId as string));

    const pageSize = sanitizeLimit(limit, { max: 100, default: 50 });
    const queryParams: any = {
      data_source_id: resolvedDataSourceId,
      page_size: pageSize,
    };
    if (filter) queryParams.filter = filter;
    if (sorts) queryParams.sorts = sorts;
    if (startCursor) queryParams.start_cursor = startCursor;

    const response: any = await wrapNotionCall(() =>
      (client as any).dataSources.query(queryParams),
    );

    const shaped = response.results.map((page: any) => {
      const base = extractPageShape(page);
      base.properties = extractProperties(page.properties, propertyNames);
      return base;
    });

    const results = resolveFieldsList(shaped as any, response.results, {
      includeRaw,
      fields,
      defaultFields: [...PAGE_COMPACT_FIELDS, 'properties'],
    });

    return {
      results,
      total: results.length,
      hasMore: response.has_more,
      nextCursor: response.next_cursor,
    };
  },
};
