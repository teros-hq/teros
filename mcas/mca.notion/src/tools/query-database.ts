import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const queryDatabase: ToolConfig = {
  description: 'Query database entries with optional filters and sorts. Returns compact results by default (just titles). Use properties parameter to get specific fields.',
  parameters: {
    type: 'object',
    properties: {
      databaseId: {
        type: 'string',
        description: 'The ID of the database to query',
      },
      filter: {
        type: 'object',
        description: 'Filter object (optional, see Notion API docs for syntax)',
      },
      sorts: {
        type: 'array',
        description: 'Array of sort objects (optional)',
        items: { type: 'object' },
      },
      pageSize: {
        type: 'number',
        description: 'Number of results per page (max 100, default 100)',
      },
      startCursor: {
        type: 'string',
        description: 'Cursor for pagination. Use next_cursor from previous response to get next page.',
      },
      properties: {
        type: 'array',
        description: 'Array of property names to include in results. If not provided, returns only title/name. Use ["*"] to get all properties.',
        items: { type: 'string' },
      },
    },
    required: ['databaseId'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { databaseId, filter, sorts, pageSize, startCursor, properties } = args as {
      databaseId: string;
      filter?: any;
      sorts?: any[];
      pageSize?: number;
      startCursor?: string;
      properties?: string[];
    };

    const queryParams: any = {
      database_id: databaseId,
      page_size: pageSize || 100,
    };

    if (filter) {
      queryParams.filter = filter;
    }

    if (sorts) {
      queryParams.sorts = sorts;
    }

    if (startCursor) {
      queryParams.start_cursor = startCursor;
    }

    const response = await client.databases.query(queryParams);

    // Helper to extract property value
    const extractValue = (prop: any): any => {
      if (!prop) return null;
      
      switch (prop.type) {
        case 'title':
          return prop.title?.map((t: any) => t.plain_text).join('') || null;
        case 'rich_text':
          return prop.rich_text?.map((t: any) => t.plain_text).join('') || null;
        case 'number':
          return prop.number;
        case 'select':
          return prop.select?.name || null;
        case 'multi_select':
          return prop.multi_select?.map((s: any) => s.name) || [];
        case 'date':
          return prop.date?.start || null;
        case 'checkbox':
          return prop.checkbox;
        case 'url':
          return prop.url;
        case 'email':
          return prop.email;
        case 'phone_number':
          return prop.phone_number;
        case 'formula':
          return prop.formula?.[prop.formula.type] || null;
        case 'relation':
          return prop.relation?.map((r: any) => r.id) || [];
        case 'rollup':
          return prop.rollup?.[prop.rollup.type] || null;
        case 'people':
          return prop.people?.map((p: any) => p.name || p.id) || [];
        case 'files':
          return prop.files?.map((f: any) => f.name || f.external?.url || f.file?.url) || [];
        case 'created_time':
          return prop.created_time;
        case 'last_edited_time':
          return prop.last_edited_time;
        case 'created_by':
          return prop.created_by?.name || prop.created_by?.id;
        case 'last_edited_by':
          return prop.last_edited_by?.name || prop.last_edited_by?.id;
        case 'status':
          return prop.status?.name || null;
        default:
          return null;
      }
    };

    // Process results to be more compact
    const compactResults = response.results.map((page: any) => {
      const result: any = {
        id: page.id,
      };

      // If properties is ["*"], return all properties
      const returnAll = properties?.includes('*');
      
      // Always try to get the title
      const props = page.properties || {};
      
      for (const [key, value] of Object.entries(props)) {
        const prop = value as any;
        
        // Always include title property
        if (prop.type === 'title') {
          result[key] = extractValue(prop);
          continue;
        }
        
        // If returnAll or property is in the list, include it
        if (returnAll || properties?.includes(key)) {
          result[key] = extractValue(prop);
        }
      }

      return result;
    });

    return {
      results: compactResults,
      total: compactResults.length,
      has_more: response.has_more,
      next_cursor: response.next_cursor,
    };
  },
};
