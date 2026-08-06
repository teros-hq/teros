import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatContact, formatCompany, formatDeal } from '../lib';

export const search: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Search across HubSpot CRM objects (contacts, companies, deals) using the v3 search API. Returns curated results. Params: query, objectType, limit?, after?, sorts?, filters?',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query string.' },
      objectType: {
        type: 'string',
        description: 'Object type to search: contacts, companies, or deals.',
        enum: ['contacts', 'companies', 'deals'],
      },
      limit: { type: 'number', description: 'Results per page. Min 1, max 100, default 50.' },
      after: { type: 'number', description: 'Pagination offset (cursor number).' },
      sorts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            propertyName: { type: 'string' },
            direction: { type: 'string', enum: ['ASCENDING', 'DESCENDING'] },
          },
        },
        description: 'Sort configuration.',
      },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            propertyName: { type: 'string' },
            operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'BETWEEN', 'IN', 'NOT_IN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY', 'CONTAINS_TOKEN', 'NOT_CONTAINS_TOKEN'] },
            value: { type: 'string' },
            values: { type: 'array', items: { type: 'string' } },
          },
        },
        description: 'Filter groups for advanced search.',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific properties to return.',
      },
    },
    required: ['query', 'objectType'],
  },
  handler: async (args, context) => {
    const { query, objectType, limit = 50, after, sorts, filters, properties } = args as {
      query: string;
      objectType: 'contacts' | 'companies' | 'deals';
      limit?: number;
      after?: number;
      sorts?: Array<{ propertyName: string; direction: 'ASCENDING' | 'DESCENDING' }>;
      filters?: Array<{ propertyName: string; operator: string; value?: string; values?: string[] }>;
      properties?: string[];
    };

    const body: Record<string, any> = {
      query,
      limit: Math.min(Math.max(limit, 1), 100),
    };

    if (after !== undefined) body.after = after;
    if (sorts) body.sorts = sorts;
    if (properties) body.properties = properties;

    if (filters && filters.length > 0) {
      body.filterGroups = filters.map((f) => ({
        filters: [
          {
            propertyName: f.propertyName,
            operator: f.operator,
            ...(f.value !== undefined && { value: f.value }),
            ...(f.values !== undefined && { values: f.values }),
          },
        ],
      }));
    }

    const data = (await hubspotRequest(context, `/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      body,
    })) as any;

    const formatter =
      objectType === 'contacts'
        ? formatContact
        : objectType === 'companies'
          ? formatCompany
          : formatDeal;

    return {
      results: (data.results ?? []).map(formatter),
      total: data.total ?? data.results?.length ?? 0,
      hasMore: !!data.paging?.next?.after,
      nextCursor: data.paging?.next?.after ?? null,
    };
  },
};
