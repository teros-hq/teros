import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatPayment, extractQueryResults } from '../lib/formatters';

export const listPayments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online payments with optional filters. Filter by customer and date range. Returns key payment fields (Id, TxnDate, CustomerRef, TotalAmt, PaymentMethod).',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'Filter payments by customer ID.' },
      dateFrom: { type: 'string', description: 'Filter payments from this date (ISO format, e.g. "2026-01-01").' },
      dateTo: { type: 'string', description: 'Filter payments up to this date (ISO format, e.g. "2026-12-31").' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50, max: 100).', default: 50, minimum: 1, maximum: 100 },
      offset: { type: 'number', description: 'Starting position for pagination (1-based, default: 1).', default: 1, minimum: 1 },
    },
  },
  handler: async (args, context) => {
    const a = args as any;
    const customerId = a.customerId as string | undefined;
    const dateFrom = a.dateFrom as string | undefined;
    const dateTo = a.dateTo as string | undefined;
    const limit = Math.min(Math.max(a.limit ?? 50, 1), 100);
    const offset = Math.max(a.offset ?? 1, 1);

    const conditions: string[] = [];
    if (customerId) {
      conditions.push(`CustomerRef = '${customerId.replace(/'/g, "''")}'`);
    }
    if (dateFrom) {
      conditions.push(`TxnDate >= '${dateFrom.replace(/'/g, "''")}'`);
    }
    if (dateTo) {
      conditions.push(`TxnDate <= '${dateTo.replace(/'/g, "''")}'`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Payment${whereClause} ORDERBY TxnDate DESC STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const payments = extractQueryResults(data, 'Payment');
    const maxResults = data?.QueryResponse?.maxResults ?? payments.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      payments: payments.map(formatPayment),
      count: payments.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getPayment: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online payment by ID. Returns the full payment object with line items (linked transactions), customer reference, and SyncToken (needed for deletes).',
  parameters: {
    type: 'object',
    properties: {
      paymentId: { type: 'string', description: 'The QuickBooks payment ID.' },
    },
    required: ['paymentId'],
  },
  handler: async (args, context) => {
    const paymentId = (args as any).paymentId as string;
    const data = (await quickbooksRequest(`payment/${paymentId}`, context, 'GET')) as any;
    const payment = data?.Payment ?? data;
    return formatPayment(payment);
  },
};

export const createPayment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online payment. If invoiceId is provided, the payment is linked to that invoice via LinkedTxn. Returns the created payment with Id. Supports payment methods: cash, check, credit_card, bank_transfer.',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'The QuickBooks customer ID making the payment.' },
      totalAmt: { type: 'number', description: 'Total payment amount.' },
      invoiceId: { type: 'string', description: 'Optional invoice ID to link this payment to. Creates a LinkedTxn on the payment line.' },
      txnDate: { type: 'string', description: 'Transaction date (ISO format, e.g. "2026-09-20"). Defaults to today.' },
      paymentMethod: {
        type: 'string',
        enum: ['cash', 'check', 'credit_card', 'bank_transfer'],
        description: 'Payment method. Maps to QuickBooks PaymentMethodRef.',
      },
    },
    required: ['customerId', 'totalAmt'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const today = new Date().toISOString().split('T')[0];

    const paymentMethodMap: Record<string, string> = {
      cash: 'Cash',
      check: 'Check',
      credit_card: 'Credit Card',
      bank_transfer: 'Bank Transfer',
    };

    const payment: Record<string, unknown> = {
      CustomerRef: { value: a.customerId },
      TotalAmt: a.totalAmt,
      TxnDate: a.txnDate ?? today,
    };

    if (a.invoiceId) {
      payment.Line = [
        {
          Amount: a.totalAmt,
          LinkedTxn: [{ TxnId: a.invoiceId, TxnType: 'Invoice' }],
        },
      ];
    }

    if (a.paymentMethod) {
      const methodName = paymentMethodMap[a.paymentMethod];
      if (methodName) {
        payment.PaymentMethodRef = { name: methodName };
      }
    }

    const data = (await quickbooksRequest('payment', context, 'POST', payment)) as any;
    const created = data?.Payment ?? data;
    return formatPayment(created);
  },
};

export const deletePayment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a QuickBooks Online payment. This permanently removes the payment record. Requires paymentId and syncToken. Use get-payment to obtain the current syncToken.',
  parameters: {
    type: 'object',
    properties: {
      paymentId: { type: 'string', description: 'The QuickBooks payment ID to delete.' },
      syncToken: { type: 'string', description: 'The current SyncToken of the payment. Get it via get-payment.' },
    },
    required: ['paymentId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const body = { Id: a.paymentId, SyncToken: a.syncToken };
    await quickbooksRequest('payment?operation=delete', context, 'POST', body);
    return {
      id: a.paymentId,
      deleted: true,
    };
  },
};
