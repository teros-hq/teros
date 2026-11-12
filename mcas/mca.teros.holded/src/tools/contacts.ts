import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw contact shape returned by the Holded API */
interface HoldedContact {
  id?: string;
  _id?: string;
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  type?: string;
  code?: string;
  trade_name?: string;
  vat_number?: string;
  bill_address?: {
    address?: string;
    city?: string;
    postal_code?: string;
    province?: string;
    country?: string;
    country_code?: string;
  };
  address?: string;
  city?: string;
  zip?: string;
  country?: string;
  custom_fields?: unknown;
  created_at?: string;
  updated_at?: string;
}

/** Curated contact output returned by our tools */
interface CuratedContact {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  type: string | null;
  code: string | null;
  tradeName: string | null;
  vatNumber: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Curated contact output with custom fields (for get-contact) */
interface CuratedContactDetail extends CuratedContact {
  customFields: unknown;
}

/** Bill address sub-object for create/update body */
interface BillAddressInput {
  address?: string;
  city?: string;
  postal_code?: string;
  province?: string;
  country?: string;
  country_code?: string;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapContact(c: HoldedContact): CuratedContact {
  return {
    id: c.id ?? c._id ?? null,
    name: c.name ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    mobile: c.mobile ?? null,
    type: c.type ?? null,
    code: c.code ?? null,
    tradeName: c.trade_name ?? null,
    vatNumber: c.vat_number ?? null,
    address: c.bill_address?.address ?? c.address ?? null,
    city: c.bill_address?.city ?? c.city ?? null,
    zip: c.bill_address?.postal_code ?? c.zip ?? null,
    country: c.bill_address?.country ?? c.country ?? null,
    createdAt: c.created_at ?? null,
    updatedAt: c.updated_at ?? null,
  };
}

function mapContactDetail(c: HoldedContact): CuratedContactDetail {
  return {
    ...mapContact(c),
    customFields: c.custom_fields ?? null,
  };
}

// =============================================================================
// LIST CONTACTS
// =============================================================================

export const listContacts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List contacts from Holded. Returns a curated list of contacts with id, name, email, phone, and other key fields. Supports pagination via page and limit.',
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
      type: {
        type: 'string',
        description: 'Filter by contact type (e.g. client, supplier, lead)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, type } = args as {
      page?: number;
      limit?: number;
      type?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (type) params.type = type;

    const data = (await holdedRequest(context, '/v2/contacts', {
      params,
    })) as HoldedContact[] | { items?: HoldedContact[]; has_more?: boolean; cursor?: string };

    const rawContacts = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const contacts = rawContacts.map(mapContact);

    return {
      contacts,
      count: contacts.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET CONTACT
// =============================================================================

export const getContact: ToolConfig = {
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
      `/v2/contacts/${encodeURIComponent(id)}`,
    )) as HoldedContact;

    return mapContactDetail(data);
  },
};

// =============================================================================
// CREATE CONTACT
// =============================================================================

export const createContact: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new contact in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Contact name' },
      type: {
        type: 'string',
        description: 'Contact type (default: client)',
        enum: ['client', 'supplier', 'lead'],
        default: 'client',
      },
      email: { type: 'string', description: 'Contact email' },
      phone: { type: 'string', description: 'Contact phone number' },
      mobile: { type: 'string', description: 'Contact mobile number' },
      code: { type: 'string', description: 'Contact code/reference' },
      tradeName: { type: 'string', description: 'Trade name' },
      vatNumber: { type: 'string', description: 'VAT/Tax identification number' },
      billAddress: {
        type: 'object',
        description: 'Billing address object',
        properties: {
          address: { type: 'string', description: 'Street address' },
          city: { type: 'string', description: 'City' },
          postal_code: { type: 'string', description: 'Postal/ZIP code' },
          province: { type: 'string', description: 'Province/state' },
          country: { type: 'string', description: 'Country' },
          country_code: { type: 'string', description: 'ISO country code (e.g. ES, US)' },
        },
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const {
      name,
      type = 'client',
      email,
      phone,
      mobile,
      code,
      tradeName,
      vatNumber,
      billAddress,
    } = args as {
      name: string;
      type?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      code?: string;
      tradeName?: string;
      vatNumber?: string;
      billAddress?: BillAddressInput;
    };

    const body: Record<string, unknown> = { name, type };
    if (email) body.email = email;
    if (phone) body.phone = phone;
    if (mobile) body.mobile = mobile;
    if (code) body.code = code;
    if (tradeName) body.trade_name = tradeName;
    if (vatNumber) body.vat_number = vatNumber;
    if (billAddress) body.bill_address = billAddress;

    const data = (await holdedRequest(context, '/v2/contacts', {
      method: 'POST',
      body,
    })) as HoldedContact;

    return mapContact(data);
  },
};

// =============================================================================
// UPDATE CONTACT
// =============================================================================

export const updateContact: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Update an existing contact in Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded contact ID' },
      name: { type: 'string', description: 'Contact name' },
      type: {
        type: 'string',
        description: 'Contact type',
        enum: ['client', 'supplier', 'lead'],
      },
      email: { type: 'string', description: 'Contact email' },
      phone: { type: 'string', description: 'Contact phone number' },
      mobile: { type: 'string', description: 'Contact mobile number' },
      code: { type: 'string', description: 'Contact code/reference' },
      tradeName: { type: 'string', description: 'Trade name' },
      vatNumber: { type: 'string', description: 'VAT/Tax identification number' },
      billAddress: {
        type: 'object',
        description: 'Billing address object',
        properties: {
          address: { type: 'string', description: 'Street address' },
          city: { type: 'string', description: 'City' },
          postal_code: { type: 'string', description: 'Postal/ZIP code' },
          province: { type: 'string', description: 'Province/state' },
          country: { type: 'string', description: 'Country' },
          country_code: { type: 'string', description: 'ISO country code (e.g. ES, US)' },
        },
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const {
      id,
      name,
      type,
      email,
      phone,
      mobile,
      code,
      tradeName,
      vatNumber,
      billAddress,
    } = args as {
      id: string;
      name?: string;
      type?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      code?: string;
      tradeName?: string;
      vatNumber?: string;
      billAddress?: BillAddressInput;
    };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (type) body.type = type;
    if (email) body.email = email;
    if (phone) body.phone = phone;
    if (mobile) body.mobile = mobile;
    if (code) body.code = code;
    if (tradeName) body.trade_name = tradeName;
    if (vatNumber) body.vat_number = vatNumber;
    if (billAddress) body.bill_address = billAddress;

    const data = (await holdedRequest(
      context,
      `/v2/contacts/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedContact;

    return mapContact(data);
  },
};

// =============================================================================
// DELETE CONTACT
// =============================================================================

export const deleteContact: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Delete a contact from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The Holded contact ID' },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/contacts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { success: true };
  },
};

// =============================================================================
// SEARCH CONTACTS
// =============================================================================

export const searchContacts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Search contacts in Holded by name. Returns matching contacts with key fields mapped to a curated output.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name to search for',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name } = args as { name: string };

    const data = (await holdedRequest(context, '/v2/contacts/search', {
      params: { name },
    })) as HoldedContact[] | { items?: HoldedContact[] };

    const rawContacts = Array.isArray(data) ? data : (data?.items ?? []);
    const contacts = rawContacts.map(mapContact);

    return { contacts, count: contacts.length };
  },
};
