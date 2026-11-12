import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from "@teros/mca-sdk";

// =============================================================================
// LIST BANKING ACCOUNTS
// =============================================================================

export const listBankingAccounts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List banking accounts from Holded. Returns bank accounts with id, name, bank, IBAN, balance, and currency.',
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

    const data = (await holdedRequest(context, '/v2/treasury/accounts', {
      params: { page, limit },
    })) as any;

    const rawAccounts = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const accounts = rawAccounts.map((a: any) => ({
      id: a.id ?? null,
      name: a.name ?? null,
      bank: a.bank ?? a.bank_name ?? null,
      iban: a.iban ?? null,
      bic: a.bic ?? a.swift ?? null,
      currency: a.currency ?? null,
      balance: a.balance ?? null,
      type: a.type ?? null,
      active: a.active ?? null,
      createdAt: a.created_at ?? null,
      updatedAt: a.updated_at ?? null,
    }));

    return { accounts, count: accounts.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET BANKING ACCOUNT
// =============================================================================

export const getBankingAccount: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single banking account from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded banking account ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/treasury/accounts/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      name: data.name ?? null,
      bank: data.bank ?? data.bank_name ?? null,
      iban: data.iban ?? null,
      bic: data.bic ?? data.swift ?? null,
      currency: data.currency ?? null,
      balance: data.balance ?? null,
      type: data.type ?? null,
      active: data.active ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// LIST BANKING MOVEMENTS
// =============================================================================

export const listBankingMovements: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List banking movements for a specific Holded bank account. Returns transactions with date, amount, description, and reconciliation status.',
  parameters: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'The Holded banking account ID',
      },
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
        description: 'Filter movements from this date (ISO 8601)',
      },
      endDate: {
        type: 'string',
        description: 'Filter movements up to this date (ISO 8601)',
      },
      type: {
        type: 'string',
        enum: ['income', 'expense'],
        description: 'Filter movements by type: income or expense',
      },
    },
    required: ['accountId'],
  },
  handler: async (args, context) => {
    const { accountId, page = 1, limit = 25, startDate, endDate, type } = args as {
      accountId: string;
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
      type?: 'income' | 'expense';
    };

    const params: Record<string, string | number> = { page, limit };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;
    if (type) params.type = type;

    const data = (await holdedRequest(
      context,
      `/v2/treasury/accounts/${encodeURIComponent(accountId)}/movements`,
      { params },
    )) as any;

    const rawMovements = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const movements = rawMovements.map((m: any) => ({
      id: m.id ?? null,
      date: m.date ?? null,
      amount: m.amount ?? null,
      currency: m.currency ?? null,
      description: m.description ?? null,
      type: m.type ?? null,
      category: m.category ?? null,
      contactId: m.contact_id ?? null,
      reconciled: m.reconciled ?? null,
      balance: m.balance ?? null,
    }));

    return { movements, count: movements.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// LIST PAYMENT METHODS
// =============================================================================

export const listPaymentMethods: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List payment methods from Holded. Payment methods define how invoices and payments are processed.',
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

    const data = (await holdedRequest(context, '/v2/payment-methods', {
      params: { page, limit },
    })) as any;

    const methods = Array.isArray(data) ? data : (data?.items ?? []);

    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    return {
      paymentMethods: methods.map((m: any) => ({
        id: m.id ?? null,
        name: m.name ?? null,
        type: m.type ?? null,
        active: m.active ?? null,
        accountId: m.account_id ?? m.treasury_account_id ?? null,
        createdAt: m.created_at ?? null,
        updatedAt: m.updated_at ?? null,
      })),
      count: methods.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET PAYMENT METHOD
// =============================================================================

export const getPaymentMethod: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single payment method from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded payment method ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/payment-methods/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      name: data.name ?? null,
      type: data.type ?? null,
      active: data.active ?? null,
      accountId: data.account_id ?? data.treasury_account_id ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// LIST REMITTANCES
// =============================================================================

export const listRemittances: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List remittances from Holded. Remittances are batch payment collections (typically SEPA direct debits).',
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
      status: {
        type: 'string',
        description: 'Filter by remittance status (e.g. draft, sent, processed)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, status } = args as {
      page?: number;
      limit?: number;
      status?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (status) params.status = status;

    const data = (await holdedRequest(context, '/v2/treasury/remittances', {
      params,
    })) as any;

    const rawRemittances = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const remittances = rawRemittances.map((r: any) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      reference: r.reference ?? null,
      date: r.date ?? null,
      total: r.total ?? r.amount ?? null,
      currency: r.currency ?? null,
      status: r.status ?? null,
      paymentCount: r.payment_count ?? r.payments_count ?? null,
      accountId: r.account_id ?? null,
      createdAt: r.created_at ?? null,
    }));

    return { remittances, count: remittances.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET REMITTANCE
// =============================================================================

export const getRemittance: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single remittance from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded remittance ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/treasury/remittances/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      name: data.name ?? null,
      reference: data.reference ?? null,
      date: data.date ?? null,
      total: data.total ?? data.amount ?? null,
      currency: data.currency ?? null,
      status: data.status ?? null,
      paymentCount: data.payment_count ?? data.payments_count ?? null,
      accountId: data.account_id ?? null,
      payments: data.payments ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};
