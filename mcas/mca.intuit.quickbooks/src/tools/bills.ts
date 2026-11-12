import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatBill, extractQueryResults } from '../lib/formatters';

export const listBills: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online bills with optional filters. Filter by vendor, status (open/paid), and date range. Returns key bill fields (Id, TxnDate, DueDate, VendorRef, TotalAmt, Balance).',
  parameters: {
    type: 'object',
    properties: {
      vendorId: { type: 'string', description: 'Filter bills by vendor ID.' },
      status: {
        type: 'string',
        enum: ['open', 'paid', 'all'],
        description: 'Filter by bill status: "open" (Balance > 0), "paid" (Balance = 0), or "all" (default).',
      },
      dateFrom: { type: 'string', description: 'Filter bills from this date (ISO format, e.g. "2026-01-01").' },
      dateTo: { type: 'string', description: 'Filter bills up to this date (ISO format, e.g. "2026-12-31").' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50, max: 100).', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'number', description: 'Starting position for pagination (1-based, default: 1).', default: 1, minimum: 1 },
    },
  },
  handler: async (args, context) => {
    const a = args as any;
    const vendorId = a.vendorId as string | undefined;
    const status = a.status as string | undefined;
    const dateFrom = a.dateFrom as string | undefined;
    const dateTo = a.dateTo as string | undefined;
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const offset = Math.max(a.offset ?? 1, 1);

    const conditions: string[] = [];
    if (vendorId) {
      conditions.push(`VendorRef = '${vendorId.replace(/'/g, "''")}'`);
    }
    if (status === 'open') {
      conditions.push(`Balance > '0'`);
    } else if (status === 'paid') {
      conditions.push(`Balance = '0'`);
    }
    if (dateFrom) {
      conditions.push(`TxnDate >= '${dateFrom.replace(/'/g, "''")}'`);
    }
    if (dateTo) {
      conditions.push(`TxnDate <= '${dateTo.replace(/'/g, "''")}'`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Bill${whereClause} ORDERBY TxnDate DESC STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const bills = extractQueryResults(data, 'Bill');
    const maxResults = data?.QueryResponse?.maxResults ?? bills.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      bills: bills.map(formatBill),
      count: bills.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getBill: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online bill by ID. Returns the full bill object with line items, vendor reference, and SyncToken (needed for updates and deletes).',
  parameters: {
    type: 'object',
    properties: {
      billId: { type: 'string', description: 'The QuickBooks bill ID.' },
    },
    required: ['billId'],
  },
  handler: async (args, context) => {
    const billId = (args as any).billId as string;
    const data = (await quickbooksRequest(`bill/${billId}`, context, 'GET')) as any;
    const bill = data?.Bill ?? data;
    return formatBill(bill);
  },
};

export const createBill: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online bill (vendor invoice). Requires a vendor ID and at least one line item with an expense account. Line items use AccountBasedExpenseLineDetail. Returns the created bill with Id and TotalAmt.',
  parameters: {
    type: 'object',
    properties: {
      vendorId: { type: 'string', description: 'The QuickBooks vendor ID for this bill.' },
      txnDate: { type: 'string', description: 'Transaction date (ISO format, e.g. "2026-09-20"). Defaults to today.' },
      dueDate: { type: 'string', description: 'Due date for the bill (ISO format, e.g. "2026-10-20").' },
      lineItems: {
        type: 'array',
        description: 'Array of expense line items. Each item must have an accountId and amount.',
        items: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The expense account ID for this line item.' },
            amount: { type: 'number', description: 'The amount for this line item.' },
            description: { type: 'string', description: 'Optional description for this line item.' },
          },
          required: ['accountId', 'amount'],
        },
      },
    },
    required: ['vendorId', 'lineItems'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const bill: any = {
      VendorRef: { value: a.vendorId },
      Line: (a.lineItems as any[]).map((item) => ({
        Amount: item.amount,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: item.accountId },
        },
        ...(item.description ? { Description: item.description } : {}),
      })),
    };

    if (a.txnDate) bill.TxnDate = a.txnDate;
    if (a.dueDate) bill.DueDate = a.dueDate;

    const data = (await quickbooksRequest('bill', context, 'POST', bill)) as any;
    const created = data?.Bill ?? data;
    return formatBill(created);
  },
};

export const updateBill: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing QuickBooks Online bill. Requires billId and syncToken (obtain syncToken via get-bill first). Only provided fields are updated; omitted fields remain unchanged.',
  parameters: {
    type: 'object',
    properties: {
      billId: { type: 'string', description: 'The QuickBooks bill ID to update.' },
      syncToken: { type: 'string', description: 'The current SyncToken of the bill. Required for optimistic concurrency. Get it via get-bill.' },
      vendorId: { type: 'string', description: 'Update the vendor reference for this bill.' },
      txnDate: { type: 'string', description: 'Update the transaction date (ISO format).' },
      dueDate: { type: 'string', description: 'Update the due date (ISO format).' },
      lineItems: {
        type: 'array',
        description: 'Replace the bill line items. Each item must have an accountId and amount.',
        items: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'The expense account ID for this line item.' },
            amount: { type: 'number', description: 'The amount for this line item.' },
            description: { type: 'string', description: 'Optional description for this line item.' },
          },
          required: ['accountId', 'amount'],
        },
      },
      privateNote: { type: 'string', description: 'Update the private note on the bill.' },
    },
    required: ['billId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const bill: any = {
      sparse: true,
      Id: a.billId,
      SyncToken: a.syncToken,
    };

    if (a.vendorId) bill.VendorRef = { value: a.vendorId };
    if (a.txnDate) bill.TxnDate = a.txnDate;
    if (a.dueDate) bill.DueDate = a.dueDate;
    if (a.privateNote) bill.PrivateNote = a.privateNote;
    if (a.lineItems) {
      bill.Line = (a.lineItems as any[]).map((item) => ({
        Amount: item.amount,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: item.accountId },
        },
        ...(item.description ? { Description: item.description } : {}),
      }));
    }

    const data = (await quickbooksRequest('bill', context, 'POST', bill)) as any;
    const updated = data?.Bill ?? data;
    return formatBill(updated);
  },
};

export const deleteBill: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a QuickBooks Online bill. This permanently removes the bill record. Requires billId and syncToken. Use get-bill to obtain the current syncToken.',
  parameters: {
    type: 'object',
    properties: {
      billId: { type: 'string', description: 'The QuickBooks bill ID to delete.' },
      syncToken: { type: 'string', description: 'The current SyncToken of the bill. Get it via get-bill.' },
    },
    required: ['billId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const body = { Id: a.billId, SyncToken: a.syncToken };
    await quickbooksRequest('bill?operation=delete', context, 'POST', body);
    return {
      id: a.billId,
      deleted: true,
    };
  },
};
