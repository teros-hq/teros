import { holdedRequest } from '../lib/index.js';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listInvoices: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description:
    'List invoices from Holded invoicing module. Returns a curated list of invoices with id, number, date, contact, total, status, and payment info. Supports pagination.',
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
        description: 'Filter by invoice status (e.g. draft, sent, paid)',
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
    if (contactId) params.contact = contactId;

    const data = (await holdedRequest(context, '/invoicing/v1/documents/invoice', {
      params,
    })) as any[];

    const invoices = Array.isArray(data)
      ? data.map((inv) => ({
          id: inv.id ?? null,
          number: inv.number ?? null,
          date: inv.date ?? null,
          dueDate: inv.dueDate ?? null,
          contactName: inv.contactName ?? null,
          contactId: inv.contact ?? null,
          total: inv.total ?? null,
          subtotal: inv.subtotal ?? null,
          tax: inv.tax ?? null,
          status: inv.status ?? null,
          paid: inv.paid ?? null,
          currency: inv.currency ?? null,
          notes: inv.notes ?? null,
          createdAt: inv.createdAt ?? null,
          updatedAt: inv.updatedAt ?? null,
        }))
      : [];

    return {
      invoices,
      count: invoices.length,
      page,
      limit,
    };
  },
};
