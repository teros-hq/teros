import type { ToolConfig } from '@teros/mca-sdk';
import { quickbooksRequest } from '../lib/client';
import { formatVendor, extractQueryResults } from '../lib/formatters';

export const listVendors: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List QuickBooks Online vendors with optional filters. Search by name, filter by active status, and paginate with limit/offset. Returns key vendor fields (Id, DisplayName, Active, Email, Balance).',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Optional search term to filter vendors by DisplayName (LIKE match). Case-insensitive.',
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
    const sql = `SELECT * FROM Vendor${whereClause} STARTPOSITION ${offset} MAXRESULTS ${limit}`;
    const encodedQuery = encodeURIComponent(sql);

    const data = (await quickbooksRequest(`query?query=${encodedQuery}`, context, 'GET')) as any;
    const vendors = extractQueryResults(data, 'Vendor');
    const maxResults = data?.QueryResponse?.maxResults ?? vendors.length;
    const startPosition = data?.QueryResponse?.startPosition ?? offset;
    const totalCount = data?.QueryResponse?.totalCount ?? undefined;

    return {
      vendors: vendors.map(formatVendor),
      count: vendors.length,
      startPosition,
      maxResults,
      ...(totalCount !== undefined ? { totalCount } : {}),
    };
  },
};

export const getVendor: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a single QuickBooks Online vendor by ID. Returns the full vendor object with all fields including SyncToken (needed for updates).',
  parameters: {
    type: 'object',
    properties: {
      vendorId: {
        type: 'string',
        description: 'The QuickBooks vendor ID.',
      },
    },
    required: ['vendorId'],
  },
  handler: async (args, context) => {
    const vendorId = (args as any).vendorId as string;
    const data = (await quickbooksRequest(`vendor/${vendorId}`, context, 'GET')) as any;
    const vendor = data?.Vendor ?? data;
    return formatVendor(vendor);
  },
};

export const createVendor: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new QuickBooks Online vendor. Returns the created vendor with Id and SyncToken. At minimum, a DisplayName is required.',
  parameters: {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        description: 'Vendor display name (required). Must be unique across all vendors.',
      },
      email: { type: 'string', description: 'Primary email address for the vendor.' },
      phone: { type: 'string', description: 'Primary phone number (free-form).' },
      companyName: { type: 'string', description: 'Company or organization name.' },
      givenName: { type: 'string', description: 'Given (first) name.' },
      familyName: { type: 'string', description: 'Family (last) name.' },
      billAddr: {
        type: 'object',
        description: 'Billing address.',
        properties: {
          Line1: { type: 'string', description: 'Street address line 1.' },
          City: { type: 'string', description: 'City name.' },
          CountrySubDivisionCode: {
            type: 'string',
            description: 'State or province code (e.g. "CO").',
          },
          PostalCode: { type: 'string', description: 'ZIP or postal code.' },
          Country: { type: 'string', description: 'Country code (e.g. "US").' },
        },
      },
      webAddr: { type: 'string', description: 'Vendor website URL.' },
      notes: { type: 'string', description: 'Free-form notes about this vendor.' },
    },
    required: ['displayName'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const vendor: Record<string, unknown> = {
      DisplayName: a.displayName,
    };

    if (a.email) vendor.PrimaryEmailAddr = { Address: a.email };
    if (a.phone) vendor.PrimaryPhone = { FreeFormNumber: a.phone };
    if (a.companyName) vendor.CompanyName = a.companyName;
    if (a.givenName) vendor.GivenName = a.givenName;
    if (a.familyName) vendor.FamilyName = a.familyName;
    if (a.billAddr) vendor.BillAddr = a.billAddr;
    if (a.webAddr) vendor.WebAddr = { URI: a.webAddr };
    if (a.notes) vendor.Notes = a.notes;

    const data = (await quickbooksRequest('vendor', context, 'POST', vendor)) as any;
    const created = data?.Vendor ?? data;
    return formatVendor(created);
  },
};

export const updateVendor: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing QuickBooks Online vendor. Requires vendorId and syncToken (obtain syncToken via get-vendor first). Only provided fields are updated; omitted fields remain unchanged. To deactivate a vendor, set active=false.',
  parameters: {
    type: 'object',
    properties: {
      vendorId: { type: 'string', description: 'The QuickBooks vendor ID to update.' },
      syncToken: {
        type: 'string',
        description:
          'The current SyncToken of the vendor. Required for optimistic concurrency. Get it via get-vendor.',
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
      webAddr: { type: 'string', description: 'Updated website URL.' },
      notes: { type: 'string', description: 'Updated notes.' },
      active: {
        type: 'boolean',
        description:
          'Set to false to deactivate (make inactive) the vendor. QuickBooks prefers deactivation over deletion.',
      },
    },
    required: ['vendorId', 'syncToken'],
  },
  handler: async (args, context) => {
    const a = args as any;
    const vendor: Record<string, unknown> = {
      Id: a.vendorId,
      SyncToken: a.syncToken,
      sparse: true,
    };

    if (a.displayName !== undefined) vendor.DisplayName = a.displayName;
    if (a.email !== undefined) vendor.PrimaryEmailAddr = { Address: a.email };
    if (a.phone !== undefined) vendor.PrimaryPhone = { FreeFormNumber: a.phone };
    if (a.companyName !== undefined) vendor.CompanyName = a.companyName;
    if (a.givenName !== undefined) vendor.GivenName = a.givenName;
    if (a.familyName !== undefined) vendor.FamilyName = a.familyName;
    if (a.billAddr !== undefined) vendor.BillAddr = a.billAddr;
    if (a.webAddr !== undefined) vendor.WebAddr = { URI: a.webAddr };
    if (a.notes !== undefined) vendor.Notes = a.notes;
    if (a.active !== undefined) vendor.Active = a.active;

    const data = (await quickbooksRequest('vendor', context, 'POST', vendor)) as any;
    const updated = data?.Vendor ?? data;
    return formatVendor(updated);
  },
};
