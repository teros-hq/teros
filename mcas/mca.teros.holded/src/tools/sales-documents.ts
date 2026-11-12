import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from "@teros/mca-sdk";

// =============================================================================
// ESTIMATES
// =============================================================================

export const listEstimates: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List estimates (quotes) from Holded. Returns estimates with id, number, date, contact, total, and status. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25, max: 100)', default: 25 },
      contactId: { type: 'string', description: 'Filter by contact ID' },
      status: { type: 'string', description: 'Filter by status (e.g. draft, sent, accepted, rejected)' },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, contactId, status } = args as {
      page?: number; limit?: number; contactId?: string; status?: string;
    };
    const params: Record<string, string | number> = { page, limit };
    if (contactId) params.contact_id = contactId;
    if (status) params.status = status;
    const data = (await holdedRequest(context, '/v2/estimates', { params })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const estimates = rawItems.map((e: any) => ({
      id: e.id ?? null, number: e.document_number ?? e.number ?? null,
      date: e.date ?? null, expiryDate: e.expiry_date ?? e.due_date ?? null,
      contactId: e.contact_id ?? null, contactName: e.contact_name ?? null,
      total: e.total ?? null, status: e.status ?? null, currency: e.currency ?? null,
      createdAt: e.created_at ?? null, updatedAt: e.updated_at ?? null,
    }));
    return { estimates, count: estimates.length, page, limit, hasMore, cursor };
  },
};

export const getEstimate: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single estimate from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded estimate ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/estimates/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null, number: data.document_number ?? data.number ?? null,
      date: data.date ?? null, expiryDate: data.expiry_date ?? data.due_date ?? null,
      contactId: data.contact_id ?? null, contactName: data.contact_name ?? null,
      total: data.total ?? null, subtotal: data.subtotal ?? null, tax: data.tax ?? null,
      status: data.status ?? null, currency: data.currency ?? null,
      items: data.items ?? data.lines ?? null, notes: data.notes ?? null,
      createdAt: data.created_at ?? null, updatedAt: data.updated_at ?? null,
    };
  },
};

export const createEstimate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new estimate (quote) in Holded.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'Contact ID' },
      date: { type: 'string', description: 'Estimate date (ISO 8601)' },
      expiryDate: { type: 'string', description: 'Expiry date (ISO 8601)' },
      currency: { type: 'string', description: 'Currency code' },
      items: { type: 'array', items: { type: 'object' }, description: 'Line items' },
      notes: { type: 'string', description: 'Notes' },
    },
    required: ['contactId'],
  },
  handler: async (args, context) => {
    const { contactId, date, expiryDate, currency, items, notes } = args as {
      contactId: string; date?: string; expiryDate?: string; currency?: string;
      items?: any[]; notes?: string;
    };
    const body: Record<string, unknown> = { contact_id: contactId };
    if (date) body.date = date;
    if (expiryDate) body.expiry_date = expiryDate;
    if (currency) body.currency = currency;
    if (items) body.items = items;
    if (notes) body.notes = notes;
    const data = (await holdedRequest(context, '/v2/estimates', { method: 'POST', body })) as any;
    return { id: data.id ?? data._id ?? null, contactId, createdAt: data.created_at ?? null };
  },
};

// =============================================================================
// PROFORMAS
// =============================================================================

export const listProformas: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List proformas from Holded. Supports pagination and filtering.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25)', default: 25 },
      contactId: { type: 'string', description: 'Filter by contact ID' },
      status: { type: 'string', description: 'Filter by status (e.g. draft, sent, accepted, rejected)' },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, contactId, status } = args as { page?: number; limit?: number; contactId?: string; status?: string };
    const params: Record<string, string | number> = { page, limit };
    if (contactId) params.contact_id = contactId;
    if (status) params.status = status;
    const data = (await holdedRequest(context, '/v2/proformas', { params })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const proformas = rawItems.map((p: any) => ({
      id: p.id ?? null, number: p.document_number ?? p.number ?? null,
      date: p.date ?? null, contactId: p.contact_id ?? null, contactName: p.contact_name ?? null,
      total: p.total ?? null, status: p.status ?? null, currency: p.currency ?? null,
      createdAt: p.created_at ?? null,
    }));
    return { proformas, count: proformas.length, page, limit, hasMore, cursor };
  },
};

export const getProforma: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single proforma from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded proforma ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/proformas/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null, number: data.document_number ?? data.number ?? null,
      date: data.date ?? null, contactId: data.contact_id ?? null, contactName: data.contact_name ?? null,
      total: data.total ?? null, subtotal: data.subtotal ?? null, tax: data.tax ?? null,
      status: data.status ?? null, currency: data.currency ?? null,
      items: data.items ?? data.lines ?? null, createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// CREDIT NOTES
// =============================================================================

export const listCreditNotes: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List credit notes from Holded. Supports pagination and filtering.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25)', default: 25 },
      contactId: { type: 'string', description: 'Filter by contact ID' },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, contactId } = args as { page?: number; limit?: number; contactId?: string };
    const params: Record<string, string | number> = { page, limit };
    if (contactId) params.contact_id = contactId;
    const data = (await holdedRequest(context, '/v2/credit-notes', { params })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const creditNotes = rawItems.map((c: any) => ({
      id: c.id ?? null, number: c.document_number ?? c.number ?? null,
      date: c.date ?? null, contactId: c.contact_id ?? null, contactName: c.contact_name ?? null,
      total: c.total ?? null, status: c.status ?? null, currency: c.currency ?? null,
      invoiceId: c.invoice_id ?? null, createdAt: c.created_at ?? null,
    }));
    return { creditNotes, count: creditNotes.length, page, limit, hasMore, cursor };
  },
};

export const getCreditNote: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single credit note from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded credit note ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/credit-notes/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null, number: data.document_number ?? data.number ?? null,
      date: data.date ?? null, contactId: data.contact_id ?? null, contactName: data.contact_name ?? null,
      total: data.total ?? null, subtotal: data.subtotal ?? null, tax: data.tax ?? null,
      status: data.status ?? null, currency: data.currency ?? null,
      invoiceId: data.invoice_id ?? null, items: data.items ?? data.lines ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// RECURRING INVOICES
// =============================================================================

export const listRecurringInvoices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List recurring invoices from Holded. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25)', default: 25 },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };
    const data = (await holdedRequest(context, '/v2/recurring-invoices', { params: { page, limit } })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const recurringInvoices = rawItems.map((r: any) => ({
      id: r.id ?? null, name: r.name ?? null,
      contactId: r.contact_id ?? null, contactName: r.contact_name ?? null,
      total: r.total ?? null, currency: r.currency ?? null,
      frequency: r.frequency ?? r.recurrence ?? null,
      nextDate: r.next_date ?? r.next_invoice_date ?? null,
      active: r.active ?? null, createdAt: r.created_at ?? null,
    }));
    return { recurringInvoices, count: recurringInvoices.length, page, limit, hasMore, cursor };
  },
};

export const getRecurringInvoice: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single recurring invoice from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded recurring invoice ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/recurring-invoices/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null, name: data.name ?? null,
      contactId: data.contact_id ?? null, contactName: data.contact_name ?? null,
      total: data.total ?? null, currency: data.currency ?? null,
      frequency: data.frequency ?? data.recurrence ?? null,
      nextDate: data.next_date ?? data.next_invoice_date ?? null,
      active: data.active ?? null, items: data.items ?? data.lines ?? null,
      createdAt: data.created_at ?? null,
    };
  },
};

// =============================================================================
// SALES RECEIPTS
// =============================================================================

export const listSalesReceipts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List sales receipts from Holded. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25)', default: 25 },
      status: { type: 'string', description: 'Filter by status (e.g. draft, sent, paid)' },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, status } = args as { page?: number; limit?: number; status?: string };
    const params: Record<string, string | number> = { page, limit };
    if (status) params.status = status;
    const data = (await holdedRequest(context, '/v2/sales-receipts', { params })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const salesReceipts = rawItems.map((r: any) => ({
      id: r.id ?? null, number: r.document_number ?? r.number ?? null,
      date: r.date ?? null, contactId: r.contact_id ?? null, contactName: r.contact_name ?? null,
      total: r.total ?? null, currency: r.currency ?? null,
      method: r.method ?? r.payment_method ?? null, createdAt: r.created_at ?? null,
    }));
    return { salesReceipts, count: salesReceipts.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET SALES RECEIPT
// =============================================================================

export const getSalesReceipt: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single sales receipt from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded sales receipt ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/sales-receipts/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null,
      number: data.document_number ?? data.number ?? null,
      date: data.date ?? null,
      contactId: data.contact_id ?? null,
      contactName: data.contact_name ?? null,
      total: data.total ?? null,
      subtotal: data.subtotal ?? null,
      tax: data.tax ?? null,
      status: data.status ?? null,
      currency: data.currency ?? null,
      method: data.method ?? data.payment_method ?? null,
      items: data.items ?? data.lines ?? null,
      notes: data.notes ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// SERVICES
// =============================================================================

export const listServices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List services from Holded. Services are non-physical sellable items.',
  parameters: {
    type: 'object',
    properties: {
      page: { type: 'number', description: 'Page number (default: 1)', default: 1 },
      limit: { type: 'number', description: 'Results per page (default: 25)', default: 25 },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as { page?: number; limit?: number };
    const data = (await holdedRequest(context, '/v2/services', { params: { page, limit } })) as any;
    const rawItems = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);
    const services = rawItems.map((s: any) => ({
      id: s.id ?? null, name: s.name ?? null, sku: s.sku ?? null,
      price: s.price ?? null, currency: s.currency ?? null,
      tax: s.tax ?? null, description: s.description ?? null,
      refundNumberingSeriesId: s.refund_numbering_series_id ?? null,
        verifactuExcluded: s.verifactu_excluded ?? null,
    }));
    return { services, count: services.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET SERVICE
// =============================================================================

export const getService: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single service from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The Holded service ID' } },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };
    const data = (await holdedRequest(context, `/v2/services/${encodeURIComponent(id)}`)) as any;
    return {
      id: data.id ?? null,
      name: data.name ?? null,
      sku: data.sku ?? null,
      price: data.price ?? null,
      currency: data.currency ?? null,
      tax: data.tax ?? null,
      description: data.description ?? null,
      active: data.active ?? null,
      customFields: data.custom_fields ?? null,
      tags: data.tags ?? null,
      createdAt: data.created_at ?? null,
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// SALES CHANNELS
// =============================================================================

export const listSalesChannels: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List sales channels from Holded. Sales channels track different distribution sources.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const data = (await holdedRequest(context, '/v2/sales-channels')) as any;
    const channels = Array.isArray(data) ? data : (data?.items ?? []);
    return {
      salesChannels: channels.map((c: any) => ({
        id: c.id ?? null, name: c.name ?? null,
        active: c.active ?? null, createdAt: c.created_at ?? null,
      })),
      count: channels.length,
    };
  },
};

// =============================================================================
// NUMBERING SERIES
// =============================================================================

export const listNumberingSeries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'List numbering series from Holded for a specific document type. Numbering series define document numbering patterns per type.',
  parameters: {
    type: 'object',
    properties: {
      documentType: {
        type: 'string',
        description: 'Document type to list numbering series for (e.g. invoice, salesreceipt, creditnote, estimate, proform, waybill, salesorder, purchase, purchaserefund, order, purchaseshipment, receiptnote, productionorder)',
      },
    },
    required: ['documentType'],
  },
  handler: async (args, context) => {
    const { documentType } = args as { documentType: string };
    const data = (await holdedRequest(
      context,
      `/v2/numbering-series/${encodeURIComponent(documentType)}`,
    )) as any;
    const series = Array.isArray(data) ? data : (data?.items ?? []);
    return {
      numberingSeries: series.map((s: any) => ({
        id: s.id ?? null, name: s.name ?? null,
        documentType: s.type ?? documentType,
        format: s.format ?? null, lastNumber: s.last ?? null,
        refundNumberingSeriesId: s.refund_numbering_series_id ?? null,
        verifactuExcluded: s.verifactu_excluded ?? null,
      })),
      count: series.length,
    };
  },
};
