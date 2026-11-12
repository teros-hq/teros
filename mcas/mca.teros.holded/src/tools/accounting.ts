import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from "@teros/mca-sdk";

// =============================================================================
// LIST ACCOUNTING ACCOUNTS
// =============================================================================

export const listAccountingAccounts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List accounting accounts (chart of accounts) from Holded. Returns accounts with id, code, name, group, and balance.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      group: {
        type: 'string',
        description: 'Filter by account group (e.g. assets, liabilities, equity, income, expenses)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, group } = args as {
      page?: number;
      limit?: number;
      group?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (group) params.group = group;

    const data = (await holdedRequest(context, '/v2/accounting-accounts', {
      params,
    })) as any;

    const rawAccounts = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const accounts = rawAccounts.map((a: any) => ({
      id: a.id ?? null,
      code: a.code ?? a.account_number ?? null,
      name: a.name ?? null,
      group: a.group ?? a.type ?? null,
      balance: a.balance ?? null,
      currency: a.currency ?? null,
      active: a.active ?? null,
      createdAt: a.created_at ?? null,
      updatedAt: a.updated_at ?? null,
    }));

    return { accounts, count: accounts.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// LIST LEDGER ENTRIES
// =============================================================================

export const listLedgerEntries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List ledger entries from Holded. Returns journal entries with date, account, debit/credit amounts, and description. If no date range is provided, defaults to the current calendar year.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      startDate: {
        type: 'string',
        description: 'Filter entries from this date (ISO 8601)',
      },
      endDate: {
        type: 'string',
        description: 'Filter entries up to this date (ISO 8601)',
      },
      accountId: {
        type: 'string',
        description: 'Filter by accounting account ID',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, startDate, endDate, accountId } = args as {
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
      accountId?: string;
    };

    // Holded's /v2/ledger-entries API requires start_date and end_date.
    // Default to the current calendar year when not provided.
    const now = new Date();
    const year = now.getUTCFullYear();
    const params: Record<string, string | number> = {
      page,
      limit,
      start_date: startDate || `${year}-01-01`,
      end_date: endDate || `${year}-12-31`,
    };
    if (accountId) params.account_id = accountId;

    const data = (await holdedRequest(context, '/v2/ledger-entries', {
      params,
    })) as any;

    const rawEntries = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const entries = rawEntries.map((e: any) => ({
      id: e.id ?? null,
      date: e.date ?? null,
      journalEntryId: e.journal_entry_id ?? e.entry_id ?? null,
      accountId: e.account_id ?? null,
      accountCode: e.account_code ?? null,
      accountName: e.account_name ?? null,
      debit: e.debit ?? null,
      credit: e.credit ?? null,
      description: e.description ?? null,
      reference: e.reference ?? null,
      createdAt: e.created_at ?? null,
    }));

    return { entries, count: entries.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// LIST EXPENSES ACCOUNTS
// =============================================================================

export const listExpensesAccounts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List expenses accounts from Holded. These are accounts used for tracking business expenses.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };

    const data = (await holdedRequest(context, '/v2/expenses-accounts', {
      params: { page, limit },
    })) as any;

    const rawAccounts = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const accounts = rawAccounts.map((a: any) => ({
      id: a.id ?? null,
      name: a.name ?? null,
      code: a.code ?? null,
      balance: a.balance ?? null,
      currency: a.currency ?? null,
      category: a.category ?? null,
      createdAt: a.created_at ?? null,
      updatedAt: a.updated_at ?? null,
    }));

    return { accounts, count: accounts.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET EXPENSES ACCOUNT
// =============================================================================

export const getExpensesAccount: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single expenses account from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded expenses account ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/expenses-accounts/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      name: data.name ?? null,
      code: data.code ?? null,
      balance: data.balance ?? null,
      currency: data.currency ?? null,
      category: data.category ?? null,
      transactions: data.transactions ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// LIST PAYMENTS
// =============================================================================

export const listPayments: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List payments from Holded. Returns payments with id, date, amount, contact, method, and related document info.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      contactId: {
        type: 'string',
        description: 'Filter payments by contact ID',
      },
      startDate: {
        type: 'string',
        description: 'Filter payments from this date (ISO 8601)',
      },
      endDate: {
        type: 'string',
        description: 'Filter payments up to this date (ISO 8601)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, contactId, startDate, endDate } = args as {
      page?: number;
      limit?: number;
      contactId?: string;
      startDate?: string;
      endDate?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (contactId) params.contact_id = contactId;
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const data = (await holdedRequest(context, '/v2/payments', {
      params,
    })) as any;

    const rawPayments = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const payments = rawPayments.map((p: any) => ({
      id: p.id ?? null,
      date: p.date ?? null,
      amount: p.amount ?? null,
      currency: p.currency ?? null,
      contactId: p.contact_id ?? null,
      contactName: p.contact_name ?? null,
      method: p.method ?? p.payment_method ?? null,
      paymentMethodId: p.method_id ?? p.payment_method_id ?? null,
      documentId: p.document_id ?? null,
      documentType: p.document_type ?? null,
      reference: p.reference ?? null,
      createdAt: p.created_at ?? null,
    }));

    return { payments, count: payments.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET PAYMENT
// =============================================================================

export const getPayment: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single payment from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded payment ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/payments/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      date: data.date ?? null,
      amount: data.amount ?? null,
      currency: data.currency ?? null,
      contactId: data.contact_id ?? null,
      contactName: data.contact_name ?? null,
      method: data.method ?? data.payment_method ?? null,
      paymentMethodId: data.method_id ?? data.payment_method_id ?? null,
      documentId: data.document_id ?? null,
      documentType: data.document_type ?? null,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// CREATE PAYMENT
// =============================================================================

export const createPayment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new payment in Holded. Payments can be linked to invoices or other documents.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID the payment is associated with' },
      amount: { type: 'number', description: 'Payment amount' },
      date: { type: 'string', description: 'Payment date (ISO 8601)' },
      paymentMethodId: { type: 'string', description: 'Payment method ID' },
      documentId: { type: 'string', description: 'Related document ID (e.g. invoice ID)' },
      documentType: { type: 'string', description: 'Type of related document (e.g. invoice, expense)' },
      currency: { type: 'string', description: 'Currency code (e.g. EUR, USD)' },
      reference: { type: 'string', description: 'Payment reference' },
      notes: { type: 'string', description: 'Payment notes' },
    },
    required: ['contactId', 'amount'],
  },
  handler: async (args, context) => {
    const {
      contactId,
      amount,
      date,
      paymentMethodId,
      documentId,
      documentType,
      currency,
      reference,
      notes,
    } = args as {
      contactId: string;
      amount: number;
      date: string;
      paymentMethodId?: string;
      documentId?: string;
      documentType?: string;
      currency?: string;
      reference?: string;
      notes?: string;
    };

    const body: Record<string, unknown> = {
      contact_id: contactId,
      amount,
      date,
    };
    if (paymentMethodId) body.payment_method_id = paymentMethodId;
    if (documentId) body.document_id = documentId;
    if (documentType) body.document_type = documentType;
    if (currency) body.currency = currency;
    if (reference) body.reference = reference;
    if (notes) body.notes = notes;

    const data = (await holdedRequest(context, '/v2/payments', {
      method: 'POST',
      body,
    })) as any;

    return {
      id: data.id ?? data._id ?? null,
      contactId,
      amount,
      date,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// UPDATE PAYMENT
// =============================================================================

export const updatePayment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing payment in Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded payment ID' },
      amount: { type: 'number', description: 'New payment amount' },
      date: { type: 'string', description: 'New payment date (ISO 8601)' },
      paymentMethodId: { type: 'string', description: 'New payment method ID' },
      reference: { type: 'string', description: 'New payment reference' },
      notes: { type: 'string', description: 'New payment notes' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, amount, date, paymentMethodId, reference, notes } = args as {
      id: string;
      amount?: number;
      date?: string;
      paymentMethodId?: string;
      reference?: string;
      notes?: string;
    };

    const body: Record<string, unknown> = {};
    if (amount !== undefined) body.amount = amount;
    if (date) body.date = date;
    if (paymentMethodId) body.payment_method_id = paymentMethodId;
    if (reference) body.reference = reference;
    if (notes) body.notes = notes;

    const data = (await holdedRequest(
      context,
      `/v2/payments/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as any;

    return {
      id,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// DELETE PAYMENT
// =============================================================================

export const deletePayment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a payment from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded payment ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/payments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};

// =============================================================================
// LIST TAXES
// =============================================================================

export const listTaxes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List taxes from Holded. Returns tax rates with id, name, percentage, and type.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const data = (await holdedRequest(context, '/v2/taxes')) as any;

    const taxes = Array.isArray(data) ? data : (data?.items ?? []);

    return {
      taxes: taxes.map((t: any) => ({
        id: t.id ?? null,
        name: t.name ?? null,
        rate: t.rate ?? t.percentage ?? null,
        type: t.type ?? null,
        account: t.account ?? t.account_id ?? null,
        active: t.active ?? null,
        createdAt: t.created_at ?? null,
      })),
      count: taxes.length,
    };
  },
};
