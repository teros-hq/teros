import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatItem, extractQueryResults } from '../lib/formatters';

export const listItems: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online items (products and services) with optional filters. Filter by type (Service, Inventory, NonInventory) and active status. Returns key item fields (Id, Name, Type, UnitPrice, IncomeAccountRef).',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['Service', 'Inventory', 'NonInventory', 'Category', 'Bundle'],
        description: 'Filter by item type.',
      },
      active: {
        type: 'boolean',
        description: 'Filter by active status. true = active only, false = inactive only.',
      },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50, max: 100).', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'number', description: 'Starting position for pagination (1-based, default: 1).', default: 1, minimum: 1 },
    },
  },
  handler: async (args, context) => {
    const a = args as any;
    const type = a.type as string | undefined;
    const active = a.active as boolean | undefined;
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const offset = Math.max(a.offset ?? 1, 1);

    const conditions: string[] = [];
    if (type) {
      conditions.push(`Type = '${type.replace(/'/g, "''")}'`);
    }
    if (active !== undefined) {
      conditions.push(`Active = ${active}`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Item${whereClause} ORDERBY Name STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const items = extractQueryResults(data, 'Item');
    const maxResults = data?.QueryResponse?.maxResults ?? items.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      items: items.map(formatItem),
      count: items.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getItem: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online item (product or service) by ID. Returns the full item object with type, price, account references, and SyncToken.',
  parameters: {
    type: 'object',
    properties: {
      itemId: { type: 'string', description: 'The QuickBooks item ID.' },
    },
    required: ['itemId'],
  },
  handler: async (args, context) => {
    const itemId = (args as any).itemId as string;
    const data = (await quickbooksRequest(`item/${itemId}`, context, 'GET')) as any;
    const item = data?.Item ?? data;
    return formatItem(item);
  },
};

export const createItem: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online item (product or service). Requires a name, type (Service, Inventory, NonInventory), and an income account reference. Optionally specify unit price and expense account. Returns the created item with Id.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name of the item (e.g. "Consulting Service").' },
      type: {
        type: 'string',
        enum: ['Service', 'Inventory', 'NonInventory', 'Category', 'Bundle'],
        description: 'The type of item.',
      },
      incomeAccountRef: { type: 'string', description: 'The income account ID for this item (sales revenue account).' },
      unitPrice: { type: 'number', description: 'The unit price (sales price) for this item.' },
      expenseAccountRef: { type: 'string', description: 'The expense account ID for this item (cost of goods sold account).' },
      description: { type: 'string', description: 'Optional description for the item.' },
      sku: { type: 'string', description: 'Optional SKU (stock keeping unit) for the item.' },
      taxable: { type: 'boolean', description: 'Whether this item is taxable. Default: false.' },
    },
    required: ['name', 'type', 'incomeAccountRef'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const item: any = {
      Name: a.name,
      Type: a.type,
      IncomeAccountRef: { value: a.incomeAccountRef },
    };

    if (a.unitPrice !== undefined) item.UnitPrice = a.unitPrice;
    if (a.expenseAccountRef) item.ExpenseAccountRef = { value: a.expenseAccountRef };
    if (a.description) item.Description = a.description;
    if (a.sku) item.Sku = a.sku;
    if (a.taxable !== undefined) item.Taxable = a.taxable;

    const data = (await quickbooksRequest('item', context, 'POST', item)) as any;
    const created = data?.Item ?? data;
    return formatItem(created);
  },
};
