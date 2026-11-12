import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatCustomer, extractQueryResults } from '../lib/formatters';

export const listCustomers: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online customers with optional filters. Search by name/email, filter by active status, and paginate with limit/offset. Returns key customer fields (Id, DisplayName, Active, Email, Balance, TotalRevenue).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Optional search term to filter customers by DisplayName (LIKE match). Case-insensitive.',
      },
      active: {
        type: 'boolean',
        description: 'Filter by active status. true = active only, false = inactive only, omit = all.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 50, max: 100).',
        default: 50,
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: 'number',
        description: 'Starting position for pagination (1-based, default: 1).',
        default: 1,
        minimum: 1,
      },
    },
  },
  handler: async (args, context) => {
    const query = (args as any).query as string | undefined;
    const active = (args as any).active as boolean | undefined;
    const limit = Math.min(Math.max((args as any).limit ?? 50, 1), 100);
    const offset = Math.max((args as any).offset ?? 1, 1);

    const conditions: string[] = [];
    if (query) {
      conditions.push(`DisplayName LIKE '%${query.replace(/'/g, "''")}%'`);
    }
    if (active !== undefined) {
      conditions.push(`Active = ${active ? 'true' : 'false'}`);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM Customer${whereClause} STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const customers = extractQueryResults(data, 'Customer');
    const maxResults = data?.QueryResponse?.maxResults ?? customers.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      customers: customers.map(formatCustomer),
      count: customers.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getCustomer: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online customer by ID. Returns the full customer object with all fields including SyncToken (needed for updates).',
  parameters: {
    type: 'object',
    properties: {
      customerId: {
        type: 'string',
        description: 'The QuickBooks customer ID.',
      },
    },
    required: ['customerId'],
  },
  handler: async (args, context) => {
    const customerId = (args as any).customerId as string;
    const data = (await quickbooksRequest(`customer/${customerId}`, context, 'GET')) as any;
    const customer = data?.Customer ?? data;
    return formatCustomer(customer);
  },
};

export const createCustomer: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online customer. Returns the created customer with Id and SyncToken. At minimum, a DisplayName is required.',
  parameters: {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        description: 'Customer display name (required). Must be unique across all customers.',
      },
      email: {
        type: 'string',
        description: 'Primary email address for the customer.',
      },
      phone: {
        type: 'string',
        description: 'Primary phone number (free-form).',
      },
      companyName: {
        type: 'string',
        description: 'Company or organization name.',
      },
      givenName: {
        type: 'string',
        description: 'Given (first) name — use for individual customers.',
      },
      familyName: {
        type: 'string',
        description: 'Family (last) name — use for individual customers.',
      },
      billAddr: {
        type: 'object',
        description: 'Billing address.',
        properties: {
          Line1: { type: 'string', description: 'Street address line 1.' },
          City: { type: 'string', description: 'City name.' },
          CountrySubDivisionCode: {
            type: 'string',
            description: 'State or province code (e.g. "TX", "CO").',
          },
          PostalCode: { type: 'string', description: 'ZIP or postal code.' },
          Country: { type: 'string', description: 'Country code (e.g. "US").' },
        },
      },
      notes: {
        type: 'string',
        description: 'Free-form notes about this customer.',
      },
    },
    required: ['displayName'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const customer: Record<string, unknown> = {
      DisplayName: a.displayName,
    };

    if (a.email) customer.PrimaryEmailAddr = { Address: a.email };
    if (a.phone) customer.PrimaryPhone = { FreeFormNumber: a.phone };
    if (a.companyName) customer.CompanyName = a.companyName;
    if (a.givenName) customer.GivenName = a.givenName;
    if (a.familyName) customer.FamilyName = a.familyName;
    if (a.billAddr) customer.BillAddr = a.billAddr;
    if (a.notes) customer.Notes = a.notes;

    const data = (await quickbooksRequest('customer', context, 'POST', customer)) as any;
    const created = data?.Customer ?? data;
    return formatCustomer(created);
  },
};

export const updateCustomer: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing QuickBooks Online customer. Requires customerId and syncToken (obtain syncToken via get-customer first). Only provided fields are updated; omitted fields remain unchanged. To deactivate a customer, set active=false.',
  parameters: {
    type: 'object',
    properties: {
      customerId: { type: 'string', description: 'The QuickBooks customer ID to update.' },
      syncToken: {
        type: 'string',
        description:
          'The current SyncToken of the customer. Required for optimistic concurrency. Get it via get-customer.',
      },
      displayName: { type: 'string', description: 'Updated display name.' },
      email: { type: 'string', description: 'Updated primary email address.' },
      phone: { type: 'string', description: 'Updated primary phone number.' },
      companyName: { type: 'string', description: 'Updated company name.' },
      givenName: { type: 'string', description: 'Updated given (first) name.' },
      familyName: { type: 'string', description: 'Updated family (last) name.' },
      billAddr: {
        type: 'object',
        description: 'Updated billing address.',
        properties: {
          Line1: { type: 'string' },
          City: { type: 'string' },
          CountrySubDivisionCode: { type: 'string' },
          PostalCode: { type: 'string' },
          Country: { type: 'string' },
        },
      },
      notes: { type: 'string', description: 'Updated notes.' },
      active: {
        type: 'boolean',
        description:
          'Set to false to deactivate (make inactive) the customer. QuickBooks prefers deactivation over deletion.',
      },
    },
    required: ['customerId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const customer: Record<string, unknown> = {
      Id: a.customerId,
      SyncToken: a.syncToken,
      sparse: true,
    };

    if (a.displayName !== undefined) customer.DisplayName = a.displayName;
    if (a.email !== undefined) customer.PrimaryEmailAddr = { Address: a.email };
    if (a.phone !== undefined) customer.PrimaryPhone = { FreeFormNumber: a.phone };
    if (a.companyName !== undefined) customer.CompanyName = a.companyName;
    if (a.givenName !== undefined) customer.GivenName = a.givenName;
    if (a.familyName !== undefined) customer.FamilyName = a.familyName;
    if (a.billAddr !== undefined) customer.BillAddr = a.billAddr;
    if (a.notes !== undefined) customer.Notes = a.notes;
    if (a.active !== undefined) customer.Active = a.active;

    const data = (await quickbooksRequest('customer', context, 'POST', customer)) as any;
    const updated = data?.Customer ?? data;
    return formatCustomer(updated);
  },
};
