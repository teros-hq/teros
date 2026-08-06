import { holdedRequest } from '../lib/index.js';
import type { ToolDefinition } from '@teros/mca-sdk';

export const getContact: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single contact from Holded by its ID. Returns full contact details including name, email, phone, address, VAT number, and custom fields.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded contact ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/invoicing/v1/contacts/${encodeURIComponent(id)}`,
    )) as any;

    return {
      id: data.id ?? null,
      name: data.name ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      mobile: data.mobile ?? null,
      type: data.type ?? null,
      code: data.code ?? null,
      tradeName: data.tradeName ?? null,
      address: data.address ?? null,
      city: data.city ?? null,
      zip: data.zip ?? null,
      country: data.country ?? null,
      vatNumber: data.vatNumber ?? null,
      customFields: data.customFields ?? null,
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  },
};
