import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatInvoice, extractQueryResults } from '../lib/formatters';

export const listInvoices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online invoices with optional filters. Filter by customer, status (open/paid/void/all), and date range. Returns key invoice fields (Id, DocNumber, TxnDate, CustomerRef, TotalAmt, Balance, DueDate).',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'Filter invoices by customer ID.' },
      status: {
        type: 'string',
        enum: ['open', 'paid', 'void', 'all'],
        description:
          'Filter by invoice status: "open" (Balance > 0), "paid" (Balance = 0), "void" (voided), "all" (no status filter). Default: "all".',
      },
      dateFrom: { type: 'string', description: 'Filter invoices from this date (ISO format, e.g. "2026-01-01").' },
      dateTo: { type: 'string', description: 'Filter invoices up to this date (ISO format, e.g. "2026-12-31").' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50, max: 100).', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'number', description: 'Starting position for pagination (1-based, default: 1).', default: 1, minimum: 1 },
    },
  },
  handler: async (args, context) => {
    const a = args as any;
    const customerId = a.customerId as string | undefined;
    const status = (a.status ?? 'all') as string;
    const dateFrom = a.dateFrom as string | undefined;
    const dateTo = a.dateTo as string | undefined;
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const offset = Math.max(a.offset ?? 1, 1);

    const conditions: string[] = [];
    if (customerId) {
      conditions.push(`CustomerRef = '${customerId.replace(/'/g, "''")}'`);
    }
    if (status === 'open') {
      conditions.push(`Balance > '0'`);
    } else if (status === 'paid') {
      conditions.push(`Balance = '0'`);
    } else if (status === 'void') {
      conditions.push(`TotalAmt = '0' AND Balance = '0'`);
    }
    if (dateFrom) {
      conditions.push(`TxnDate >= '${dateFrom.replace(/'/g, "''")}'`);
    }
    if (dateTo) {
      conditions.push(`TxnDate <= '${dateTo.replace(/'/g, "''")}'`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Invoice${whereClause} ORDERBY TxnDate DESC STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const invoices = extractQueryResults(data, 'Invoice');
    const maxResults = data?.QueryResponse?.maxResults ?? invoices.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      invoices: invoices.map(formatInvoice),
      count: invoices.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getInvoice: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online invoice by ID. Returns the full invoice object with line items, customer reference, totals, and SyncToken (needed for updates/void).',
  parameters: {
    type: 'object',
    properties: {
      invoiceId: { type: 'string', description: 'The QuickBooks invoice ID.' },
    },
    required: ['invoiceId'],
  },
  handler: async (args, context) => {
    const invoiceId = (args as any).invoiceId as string;
    const data = (await quickbooksRequest(`invoice/${invoiceId}`, context, 'GET')) as any;
    const invoice = data?.Invoice ?? data;
    return formatInvoice(invoice);
  },
};

export const createInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online invoice with line items. Returns the created invoice with Id, DocNumber, TotalAmt, and Balance. Each line item requires an itemId (ItemRef), quantity, and unitPrice.',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'The QuickBooks customer ID to bill.' },
      txnDate: { type: 'string', description: 'Transaction date (ISO format, e.g. "2026-09-20"). Defaults to today.' },
      lineItems: {
        type: 'array',
        description: 'Line items for the invoice. Each item requires itemId, quantity, and unitPrice.',
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string', description: 'QuickBooks Item ID (ItemRef value).' },
            quantity: { type: 'number', description: 'Quantity for this line item.' },
            unitPrice: { type: 'number', description: 'Unit price for this line item.' },
            description: { type: 'string', description: 'Optional description for this line item.' },
          },
          required: ['itemId', 'quantity', 'unitPrice'],
        },
      },
      billEmail: { type: 'string', description: 'Billing email address for the invoice.' },
      customerMemo: { type: 'string', description: 'Memo visible to the customer on the invoice.' },
    },
    required: ['customerId', 'lineItems'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const today = new Date().toISOString().split('T')[0];

    const invoice: Record<string, unknown> = {
      CustomerRef: { value: a.customerId },
      TxnDate: a.txnDate ?? today,
      Line: (a.lineItems as any[]).map((item) => {
        const line: Record<string, unknown> = {
          Amount: item.quantity * item.unitPrice,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: {
            ItemRef: { value: item.itemId },
            Qty: item.quantity,
            UnitPrice: item.unitPrice,
          },
        };
        if (item.description) line.Description = item.description;
        return line;
      }),
    };

    if (a.billEmail) invoice.BillEmail = { Address: a.billEmail };
    if (a.customerMemo) invoice.CustomerMemo = { value: a.customerMemo };

    const data = (await quickbooksRequest('invoice', context, 'POST', invoice)) as any;
    const created = data?.Invoice ?? data;
    return formatInvoice(created);
  },
};

export const updateInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing QuickBooks Online invoice. Requires invoiceId and syncToken (obtain syncToken via get-invoice first). Only provided fields are updated; omitted fields remain unchanged.',
  parameters: {
    type: 'object',
    properties: {
      invoiceId: { type: 'string', description: 'The QuickBooks invoice ID to update.' },
      syncToken: { type: 'string', description: 'The current SyncToken of the invoice. Required for optimistic concurrency. Get it via get-invoice.' },
      txnDate: { type: 'string', description: 'Updated transaction date (ISO format).' },
      dueDate: { type: 'string', description: 'Updated due date (ISO format).' },
      billEmail: { type: 'string', description: 'Updated billing email address.' },
      customerMemo: { type: 'string', description: 'Updated memo visible to the customer.' },
      privateNote: { type: 'string', description: 'Updated private note (not visible to customer).' },
      lineItems: {
        type: 'array',
        description: 'Updated line items. Replaces all existing line items.',
        items: {
          type: 'object',
          properties: {
            itemId: { type: 'string', description: 'QuickBooks Item ID (ItemRef value).' },
            quantity: { type: 'number', description: 'Quantity for this line item.' },
            unitPrice: { type: 'number', description: 'Unit price for this line item.' },
            description: { type: 'string', description: 'Optional description for this line item.' },
          },
          required: ['itemId', 'quantity', 'unitPrice'],
        },
      },
    },
    required: ['invoiceId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const invoice: Record<string, unknown> = {
      Id: a.invoiceId,
      SyncToken: a.syncToken,
      sparse: true,
    };

    if (a.txnDate !== undefined) invoice.TxnDate = a.txnDate;
    if (a.dueDate !== undefined) invoice.DueDate = a.dueDate;
    if (a.billEmail !== undefined) invoice.BillEmail = { Address: a.billEmail };
    if (a.customerMemo !== undefined) invoice.CustomerMemo = { value: a.customerMemo };
    if (a.privateNote !== undefined) invoice.PrivateNote = a.privateNote;
    if (a.lineItems !== undefined) {
      invoice.Line = (a.lineItems as any[]).map((item: any) => {
        const line: Record<string, unknown> = {
          Amount: item.quantity * item.unitPrice,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: {
            ItemRef: { value: item.itemId },
            Qty: item.quantity,
            UnitPrice: item.unitPrice,
          },
        };
        if (item.description) line.Description = item.description;
        return line;
      });
    }

    const data = (await quickbooksRequest('invoice', context, 'POST', invoice)) as any;
    const updated = data?.Invoice ?? data;
    return formatInvoice(updated);
  },
};

export const voidInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Void a QuickBooks Online invoice. The invoice record is preserved but marked as voided (Balance and TotalAmt set to 0). Requires invoiceId and syncToken. Use get-invoice to obtain the current syncToken.',
  parameters: {
    type: 'object',
    properties: {
      invoiceId: { type: 'string', description: 'The QuickBooks invoice ID to void.' },
      syncToken: { type: 'string', description: 'The current SyncToken of the invoice. Get it via get-invoice.' },
    },
    required: ['invoiceId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const body = { Id: a.invoiceId, SyncToken: a.syncToken };
    const data = (await quickbooksRequest(
      'invoice?operation=void',
      context,
      'POST',
      body,
    )) as any;
    const voided = data?.Invoice ?? data;
    return {
      id: voided?.Id ?? a.invoiceId,
      syncToken: voided?.SyncToken ?? null,
      docNumber: voided?.DocNumber ?? null,
      totalAmt: voided?.TotalAmt ?? 0,
      balance: voided?.Balance ?? 0,
      voided: true,
    };
  },
};

export const sendInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Send a QuickBooks Online invoice to the customer via email. If no email address is provided, uses the BillEmail stored on the invoice. Returns the delivery status.',
  parameters: {
    type: 'object',
    properties: {
      invoiceId: { type: 'string', description: 'The QuickBooks invoice ID to send.' },
      email: { type: 'string', description: 'Email address to send the invoice to. If omitted, uses the invoice BillEmail.' },
    },
    required: ['invoiceId'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const invoiceId = a.invoiceId as string;
    const email = a.email as string | undefined;

    let path = `invoice/${invoiceId}/send`;
    if (email) {
      path += `?sendTo=${encodeURIComponent(email)}`;
    }

    const data = (await quickbooksRequest(path, context, 'POST') as any);
    const invoice = data?.Invoice ?? data;
    return {
      id: invoice?.Id ?? invoiceId,
      docNumber: invoice?.DocNumber ?? null,
      emailStatus: invoice?.EmailStatus ?? null,
      billEmail: invoice?.BillEmail?.Address ?? email ?? null,
      sent: true,
    };
  },
};
