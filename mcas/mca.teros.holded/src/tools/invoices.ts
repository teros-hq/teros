import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw invoice shape returned by the Holded API */
interface HoldedInvoice {
  id?: string;
  _id?: string;
  document_number?: string;
  number?: string;
  date?: string;
  due_date?: string;
  contact_id?: string;
  contact?: string;
  contact_name?: string;
  description?: string;
  notes?: string;
  total?: number;
  subtotal?: number;
  tax?: number;
  status?: string;
  draft?: boolean;
  currency?: string;
  items?: unknown[];
  lines?: unknown[];
  payments_total?: number;
  payments_pending?: number;
  custom_fields?: unknown;
  tags?: string[];
  payment_method_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** Curated invoice list item */
interface CuratedInvoiceListItem {
  id: string | null;
  number: string | null;
  date: string | null;
  dueDate: string | null;
  contactName: string | null;
  contactId: string | null;
  description: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  status: string | null;
  draft: boolean | null;
  currency: string | null;
  paymentsTotal: number | null;
  paymentsPending: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Curated invoice detail (for get-invoice) */
interface CuratedInvoiceDetail extends Omit<CuratedInvoiceListItem, 'id'> {
  id: string | null;
  notes: string | null;
  items: unknown | null;
  customFields: unknown;
  tags: string[] | null;
  paymentMethodId: string | null;
}

/** Line item input for create/update */
interface InvoiceLineInput {
  name?: string;
  description?: string;
  price?: number;
  units?: number;
  discount?: number;
  tax?: number;
  taxes?: unknown;
  product_id?: string;
  productId?: string;
  service_id?: string;
  serviceId?: string;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapInvoiceListItem(inv: HoldedInvoice): CuratedInvoiceListItem {
  return {
    id: inv.id ?? inv._id ?? null,
    number: inv.document_number ?? inv.number ?? null,
    date: inv.date ?? null,
    dueDate: inv.due_date ?? null,
    contactName: inv.contact_name ?? null,
    contactId: inv.contact_id ?? inv.contact ?? null,
    description: inv.description ?? null,
    total: inv.total ?? null,
    subtotal: inv.subtotal ?? null,
    tax: inv.tax ?? null,
    status: inv.status ?? null,
    draft: inv.draft ?? null,
    currency: inv.currency ?? null,
    paymentsTotal: inv.payments_total ?? null,
    paymentsPending: inv.payments_pending ?? null,
    createdAt: inv.created_at ?? null,
    updatedAt: inv.updated_at ?? null,
  };
}

function mapInvoiceDetail(data: HoldedInvoice): CuratedInvoiceDetail {
  return {
    id: data.id ?? data._id ?? null,
    number: data.document_number ?? data.number ?? null,
    date: data.date ?? null,
    dueDate: data.due_date ?? null,
    contactName: data.contact_name ?? null,
    contactId: data.contact_id ?? data.contact ?? null,
    description: data.description ?? null,
    notes: data.notes ?? null,
    total: data.total ?? null,
    subtotal: data.subtotal ?? null,
    tax: data.tax ?? null,
    status: data.status ?? null,
    draft: data.draft ?? null,
    currency: data.currency ?? null,
    items: data.items ?? data.lines ?? null,
    paymentsTotal: data.payments_total ?? null,
    paymentsPending: data.payments_pending ?? null,
    customFields: data.custom_fields ?? null,
    tags: data.tags ?? null,
    paymentMethodId: data.payment_method_id ?? null,
    createdAt: data.created_at ?? null,
    updatedAt: data.updated_at ?? null,
  };
}

/** Convert camelCase line input to snake_case for the Holded API */
function mapLineInput(line: InvoiceLineInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (line.name !== undefined) out.name = line.name;
  if (line.description !== undefined) out.description = line.description;
  if (line.price !== undefined) out.price = line.price;
  if (line.units !== undefined) out.units = line.units;
  if (line.discount !== undefined) out.discount = line.discount;
  if (line.tax !== undefined) out.tax = line.tax;
  if (line.taxes !== undefined) out.taxes = line.taxes;
  if (line.product_id !== undefined) out.product_id = line.product_id;
  else if (line.productId !== undefined) out.product_id = line.productId;
  if (line.service_id !== undefined) out.service_id = line.service_id;
  else if (line.serviceId !== undefined) out.service_id = line.serviceId;
  return out;
}

// =============================================================================
// LIST INVOICES
// =============================================================================

export const listInvoices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List invoices from Holded. Returns a curated list of invoices with id, number, date, contact, total, status, and payment info. Supports pagination.',
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
        description: 'Filter by invoice status (e.g. draft, sent, paid, completed)',
      },
      contactId: {
        type: 'string',
        description: 'Filter invoices by contact ID',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, status, contactId } = args as {
      page?: number;
      limit?: number;
      status?: string;
      contactId?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (status) params.status = status;
    if (contactId) params.contact_id = contactId;

    const data = (await holdedRequest(context, '/v2/invoices', {
      params,
    })) as HoldedInvoice[] | { items?: HoldedInvoice[]; has_more?: boolean; cursor?: string };

    const rawInvoices = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const invoices = rawInvoices.map(mapInvoiceListItem);

    return {
      invoices,
      count: invoices.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET INVOICE
// =============================================================================

export const getInvoice: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single invoice from Holded by its ID, including line items and full details.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}`,
    )) as HoldedInvoice;

    return mapInvoiceDetail(data);
  },
};

// =============================================================================
// CREATE INVOICE
// =============================================================================

export const createInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new invoice in Holded.',
  parameters: {
    type: 'object',
    properties: {
      contactId: {
        type: 'string',
        description: 'Contact ID for the invoice recipient',
      },
      date: { type: 'string', description: 'Invoice date (ISO 8601, e.g. 2026-01-15)' },
      dueDate: { type: 'string', description: 'Invoice due date (ISO 8601)' },
      description: { type: 'string', description: 'Invoice description or title' },
      lines: {
        type: 'array',
        description: 'Invoice line items',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Line item name' },
            description: { type: 'string', description: 'Line item description' },
            price: { type: 'number', description: 'Unit price' },
            units: { type: 'number', description: 'Quantity (default: 1)' },
            discount: { type: 'number', description: 'Discount percentage (0-100)' },
            tax: { type: 'number', description: 'Tax rate percentage' },
            taxes: {
              type: 'array',
              description: 'Array of tax objects (alternative to single tax rate)',
              items: { type: 'object' },
            },
            productId: { type: 'string', description: 'Related product ID' },
            serviceId: { type: 'string', description: 'Related service ID' },
          },
        },
      },
      currency: { type: 'string', description: 'Currency code (e.g. EUR, USD)' },
      tags: {
        type: 'array',
        description: 'Tags to assign to the invoice',
        items: { type: 'string' },
      },
      paymentMethodId: {
        type: 'string',
        description: 'Payment method ID',
      },
      customFields: {
        type: 'object',
        description: 'Custom fields key-value pairs',
      },
    },
    required: ['contactId'],
  },
  handler: async (args, context) => {
    const {
      contactId,
      date,
      dueDate,
      description,
      lines,
      currency,
      tags,
      paymentMethodId,
      customFields,
    } = args as {
      contactId: string;
      date?: string;
      dueDate?: string;
      description?: string;
      lines?: InvoiceLineInput[];
      currency?: string;
      tags?: string[];
      paymentMethodId?: string;
      customFields?: Record<string, unknown>;
    };

    const body: Record<string, unknown> = { contact_id: contactId };
    if (date) body.date = date;
    if (dueDate) body.due_date = dueDate;
    if (description) body.description = description;
    if (lines) body.lines = lines.map(mapLineInput);
    if (currency) body.currency = currency;
    if (tags) body.tags = tags;
    if (paymentMethodId) body.payment_method_id = paymentMethodId;
    if (customFields) body.custom_fields = customFields;

    const data = (await holdedRequest(context, '/v2/invoices', {
      method: 'POST',
      body,
    })) as HoldedInvoice;

    return mapInvoiceDetail(data);
  },
};

// =============================================================================
// UPDATE INVOICE
// =============================================================================

export const updateInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing invoice in Holded by its ID. All fields are optional.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
      contactId: {
        type: 'string',
        description: 'Contact ID for the invoice recipient',
      },
      date: { type: 'string', description: 'Invoice date (ISO 8601)' },
      dueDate: { type: 'string', description: 'Invoice due date (ISO 8601)' },
      description: { type: 'string', description: 'Invoice description' },
      lines: {
        type: 'array',
        description: 'Updated line items (replaces existing)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Line item name' },
            description: { type: 'string', description: 'Line item description' },
            price: { type: 'number', description: 'Unit price' },
            units: { type: 'number', description: 'Quantity' },
            discount: { type: 'number', description: 'Discount percentage (0-100)' },
            tax: { type: 'number', description: 'Tax rate percentage' },
            taxes: {
              type: 'array',
              description: 'Array of tax objects',
              items: { type: 'object' },
            },
            productId: { type: 'string', description: 'Related product ID' },
            serviceId: { type: 'string', description: 'Related service ID' },
          },
        },
      },
      currency: { type: 'string', description: 'Currency code (e.g. EUR, USD)' },
      tags: {
        type: 'array',
        description: 'Tags to assign to the invoice',
        items: { type: 'string' },
      },
      paymentMethodId: {
        type: 'string',
        description: 'Payment method ID',
      },
      customFields: {
        type: 'object',
        description: 'Custom fields key-value pairs',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const {
      id,
      contactId,
      date,
      dueDate,
      description,
      lines,
      currency,
      tags,
      paymentMethodId,
      customFields,
    } = args as {
      id: string;
      contactId?: string;
      date?: string;
      dueDate?: string;
      description?: string;
      lines?: InvoiceLineInput[];
      currency?: string;
      tags?: string[];
      paymentMethodId?: string;
      customFields?: Record<string, unknown>;
    };

    const body: Record<string, unknown> = {};
    if (contactId) body.contact_id = contactId;
    if (date) body.date = date;
    if (dueDate) body.due_date = dueDate;
    if (description) body.description = description;
    if (lines) body.lines = lines.map(mapLineInput);
    if (currency) body.currency = currency;
    if (tags) body.tags = tags;
    if (paymentMethodId) body.payment_method_id = paymentMethodId;
    if (customFields) body.custom_fields = customFields;

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedInvoice;

    return mapInvoiceDetail(data);
  },
};

// =============================================================================
// DELETE INVOICE
// =============================================================================

export const deleteInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete an invoice from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/invoices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { id, deleted: true };
  },
};

// =============================================================================
// CANCEL INVOICE
// =============================================================================

export const cancelInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Cancel an invoice in Holded by its ID. This changes the invoice status to cancelled.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
      reason: { type: 'string', description: 'Reason for cancellation' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, reason } = args as { id: string; reason?: string };

    const body: Record<string, string> = {};
    if (reason) body.reason = reason;

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body },
    )) as HoldedInvoice;

    return {
      id,
      status: 'cancelled',
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// APPROVE INVOICE
// =============================================================================

export const approveInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Approve an invoice in Holded by its ID. This moves a draft invoice to approved/sent status.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}/approve`,
      { method: 'POST' },
    )) as HoldedInvoice;

    return {
      id,
      status: 'approved',
      updatedAt: data.updated_at ?? null,
    };
  },
};

// =============================================================================
// SEND INVOICE
// =============================================================================

export const sendInvoice: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Send an invoice to the contact via email from Holded. Defaults to the contact\'s email if no email is provided.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
      email: {
        type: 'string',
        description: 'Override recipient email address (defaults to contact email)',
      },
      subject: {
        type: 'string',
        description: 'Custom email subject line',
      },
      message: {
        type: 'string',
        description: 'Custom message to include in the email body',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, email, subject, message } = args as {
      id: string;
      email?: string;
      subject?: string;
      message?: string;
    };

    const body: Record<string, string> = {};
    if (email) body.email = email;
    if (subject) body.subject = subject;
    if (message) body.message = message;

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}/send`,
      { method: 'POST', body },
    )) as HoldedInvoice;

    return {
      id,
      sent: true,
      sentAt: data.updated_at ?? data.created_at ?? null,
    };
  },
};

// =============================================================================
// FIND INVOICES BY NUMBER
// =============================================================================

export const findInvoices: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search invoices in Holded by document number. Returns matching invoices with key fields.',
  parameters: {
    type: 'object',
    properties: {
      documentNumber: {
        type: 'string',
        description: 'The invoice document number to search for (e.g. INV-2026-001)',
      },
    },
    required: ['documentNumber'],
  },
  handler: async (args, context) => {
    const { documentNumber } = args as { documentNumber: string };

    const data = (await holdedRequest(context, '/v2/invoices/search', {
      params: { document_number: documentNumber },
    })) as HoldedInvoice[] | { items?: HoldedInvoice[] };

    const rawInvoices = Array.isArray(data) ? data : (data?.items ?? []);
    const invoices = rawInvoices.map(mapInvoiceListItem);

    return { invoices, count: invoices.length, query: documentNumber };
  },
};

// =============================================================================
// GET INVOICE PDF
// =============================================================================

export const getInvoicePdf: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Download the PDF of an invoice from Holded. Returns the PDF as a base64-encoded string with a filename.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded invoice ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/invoices/${encodeURIComponent(id)}/pdf`,
      { responseType: 'arrayBuffer' },
    )) as { buffer: ArrayBuffer; contentType: string };

    // Convert ArrayBuffer to base64
    const bytes = new Uint8Array(data.buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    const pdfBase64 = btoa(binary);

    // Try to extract filename from Content-Disposition header, or construct one
    const filename = `invoice-${id}.pdf`;

    return {
      id,
      pdf: pdfBase64,
      filename,
      contentType: data.contentType,
      size: bytes.length,
    };
  },
};
