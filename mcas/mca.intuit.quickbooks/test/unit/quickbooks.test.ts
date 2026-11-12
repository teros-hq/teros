/**
 * Unit tests for mca.intuit.quickbooks
 *
 * Tests cover:
 * - Helper functions (getBaseUrl, buildBasicAuthHeader)
 * - Token management (getValidAccessToken, refreshAccessToken)
 * - quickbooksRequest URL construction, error handling (401/429/404/500), token refresh
 * - All tool handlers: request construction, body parsing, response formatting
 * - Formatters: correct field extraction from raw QuickBooks responses
 *
 * Strategy: mock global `fetch` to intercept all HTTP calls. Build a mock
 * ToolContext with controllable secrets. No real network calls.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  PRODUCTION_BASE_URL,
  SANDBOX_BASE_URL,
  TOKEN_URL,
  TOKEN_REFRESH_BUFFER_MS,
  RATE_LIMIT_BACKOFF_MS,
  getBaseUrl,
  buildBasicAuthHeader,
  refreshAccessToken,
  getValidAccessToken,
  quickbooksRequest,
  sleep,
} from '../../src/lib/client';
import {
  formatCompanyInfo,
  formatCustomer,
  formatVendor,
  formatInvoice,
  formatInvoiceLine,
  formatPayment,
  formatPaymentLine,
  formatBill,
  formatBillLine,
  formatAccount,
  formatItem,
  formatReport,
  formatReportHeader,
  formatReportColumns,
  formatReportRows,
  extractQueryResults,
  extractPLSummary,
  extractAgingBuckets,
} from '../../src/lib/formatters';

import {
  getCompanyInfo,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  listVendors,
  getVendor,
  createVendor,
  updateVendor,
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  voidInvoice,
  sendInvoice,
  listPayments,
  getPayment,
  createPayment,
  deletePayment,
  listBills,
  getBill,
  createBill,
  updateBill,
  deleteBill,
  listAccounts,
  getAccount,
  createAccount,
  listItems,
  getItem,
  createItem,
  reportProfitLoss,
  reportBalanceSheet,
  reportCashFlow,
  reportAgedReceivables,
  reportAgedPayables,
  reportTrialBalance,
  reportGeneralLedger,
  reportCustomerBalance,
  reportSalesByCustomer,
} from '../../src/tools';

// =============================================================================
// MOCK INFRASTRUCTURE
// =============================================================================

const REALM_ID = 'test-realm-123';
const ACCESS_TOKEN = 'test-access-token';
const REFRESH_TOKEN = 'test-refresh-token';
const NEW_ACCESS_TOKEN = 'new-access-token';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';

/** Far-future expiry so getValidAccessToken returns the cached token without refresh. */
const FUTURE_EXPIRY = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
/** Past expiry so getValidAccessToken triggers a refresh. */
const PAST_EXPIRY = new Date(Date.now() - 60 * 1000).toISOString();

interface FetchLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let fetchLogs: FetchLog[] = [];
let fetchResponses: { status: number; body: unknown; headers?: Record<string, string> }[] = [];

function mockFetch(_global: typeof globalThis) {
  const originalFetch = globalThis.fetch;
  const fn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    const body = init?.body ? String(init.body) : null;

    fetchLogs.push({ url, method, headers, body });

    const resp = fetchResponses.shift() ?? { status: 200, body: {} };
    const responseHeaders = new Headers(resp.headers ?? {});
    const text = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    return new Response(text, {
      status: resp.status,
      headers: responseHeaders,
    }) as any;
  });
  globalThis.fetch = fn as any;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function setupResponses(...responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  fetchResponses = [...responses];
}

function buildContext(overrides: {
  /** When true, overrides.userSecrets fully replaces the default secrets. */
  replaceUserSecrets?: boolean;
  /** When true, overrides.systemSecrets fully replaces the default secrets. */
  replaceSystemSecrets?: boolean;
  userSecrets?: Record<string, string>;
  systemSecrets?: Record<string, string>;
  updateUserSecrets?: (s: Record<string, string>) => Promise<void>;
} = {}) {
  const defaultUserSecrets: Record<string, string> = {
    ACCESS_TOKEN,
    REFRESH_TOKEN,
    REALM_ID,
    EXPIRY_DATE: FUTURE_EXPIRY,
  };
  const defaultSystemSecrets: Record<string, string> = {
    CLIENT_ID,
    CLIENT_SECRET,
  };
  const userSecrets: Record<string, string> = overrides.replaceUserSecrets
    ? (overrides.userSecrets ?? {})
    : { ...defaultUserSecrets, ...overrides.userSecrets };
  const systemSecrets: Record<string, string> = overrides.replaceSystemSecrets
    ? (overrides.systemSecrets ?? {})
    : { ...defaultSystemSecrets, ...overrides.systemSecrets };
  return {
    execution: { userId: 'u1', appId: 'a1', mcaId: 'mca.intuit.quickbooks' },
    requestId: 'req-test',
    backend: null,
    signal: new AbortController().signal,
    getSystemSecrets: async () => systemSecrets,
    getUserSecrets: async () => userSecrets,
    updateUserSecrets: overrides.updateUserSecrets ?? (async () => {}),
    agentList: async () => ({ agents: [] }),
    agentGet: async () => ({}),
    agentCreate: async () => ({}),
    agentUpdate: async () => ({}),
    agentDelete: async () => ({}),
    agentAppsList: async () => ({ apps: [] }),
    agentProvidersGet: async () => ({}),
    agentProvidersSet: async () => ({}),
    agentPreferredProviderSet: async () => ({}),
    providerList: async () => ({ providers: [] }),
    workspaceList: async () => ({ workspaces: [] }),
    workspaceGet: async () => ({}),
    workspaceCreate: async () => ({}),
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
  } as any;
}

function lastLog(): FetchLog {
  return fetchLogs[fetchLogs.length - 1];
}

function allLogs(): FetchLog[] {
  return [...fetchLogs];
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

let restoreFetch: (() => void) | null = null;

beforeEach(() => {
  fetchLogs = [];
  fetchResponses = [];
  restoreFetch = mockFetch(globalThis);
});

afterEach(() => {
  if (restoreFetch) restoreFetch();
  restoreFetch = null;
});

// =============================================================================
// HELPER FUNCTION TESTS
// =============================================================================

describe('getBaseUrl', () => {
  it('returns production URL when QUICKBOOKS_USE_SANDBOX is not set', () => {
    expect(getBaseUrl({})).toBe(PRODUCTION_BASE_URL);
  });

  it('returns production URL when QUICKBOOKS_USE_SANDBOX is "false"', () => {
    expect(getBaseUrl({ QUICKBOOKS_USE_SANDBOX: 'false' })).toBe(PRODUCTION_BASE_URL);
  });

  it('returns sandbox URL when QUICKBOOKS_USE_SANDBOX is "true"', () => {
    expect(getBaseUrl({ QUICKBOOKS_USE_SANDBOX: 'true' })).toBe(SANDBOX_BASE_URL);
  });

  it('returns sandbox URL when QUICKBOOKS_USE_SANDBOX is "TRUE" (case-insensitive)', () => {
    expect(getBaseUrl({ QUICKBOOKS_USE_SANDBOX: 'TRUE' })).toBe(SANDBOX_BASE_URL);
  });
});

describe('buildBasicAuthHeader', () => {
  it('returns Basic auth header with base64-encoded credentials', () => {
    const header = buildBasicAuthHeader(CLIENT_ID, CLIENT_SECRET);
    expect(header).toMatch(/^Basic /);
    const decoded = atob(header.replace('Basic ', ''));
    expect(decoded).toBe(`${CLIENT_ID}:${CLIENT_SECRET}`);
  });

  it('produces different headers for different credentials', () => {
    const h1 = buildBasicAuthHeader('id1', 'secret1');
    const h2 = buildBasicAuthHeader('id2', 'secret2');
    expect(h1).not.toBe(h2);
  });
});

describe('sleep', () => {
  it('resolves after the specified milliseconds', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

// =============================================================================
// TOKEN MANAGEMENT TESTS
// =============================================================================

describe('getValidAccessToken', () => {
  it('returns cached token when expiry is far in the future', async () => {
    const ctx = buildContext();
    const token = await getValidAccessToken(ctx);
    expect(token).toBe(ACCESS_TOKEN);
    // Should not have called fetch (no refresh)
    expect(fetchLogs).toHaveLength(0);
  });

  it('triggers refresh when token is expired', async () => {
    const ctx = buildContext({
      userSecrets: { ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID, EXPIRY_DATE: PAST_EXPIRY },
    });
    setupResponses({
      status: 200,
      body: { access_token: NEW_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await getValidAccessToken(ctx);
    expect(token).toBe(NEW_ACCESS_TOKEN);
    expect(fetchLogs).toHaveLength(1);
    expect(fetchLogs[0].url).toBe(TOKEN_URL);
    expect(fetchLogs[0].method).toBe('POST');
  });

  it('triggers refresh when EXPIRY_DATE is missing', async () => {
    const ctx = buildContext({
      userSecrets: { ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID },
      replaceUserSecrets: true,
    });
    setupResponses({
      status: 200,
      body: { access_token: NEW_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await getValidAccessToken(ctx);
    expect(token).toBe(NEW_ACCESS_TOKEN);
  });

  it('triggers refresh when ACCESS_TOKEN is missing', async () => {
    const ctx = buildContext({
      userSecrets: { REFRESH_TOKEN, REALM_ID, EXPIRY_DATE: FUTURE_EXPIRY },
      replaceUserSecrets: true,
    });
    setupResponses({
      status: 200,
      body: { access_token: NEW_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await getValidAccessToken(ctx);
    expect(token).toBe(NEW_ACCESS_TOKEN);
  });
});

describe('refreshAccessToken', () => {
  it('throws when CLIENT_ID is missing', async () => {
    const ctx = buildContext({ systemSecrets: { CLIENT_SECRET }, replaceSystemSecrets: true });
    await expect(refreshAccessToken(ctx)).rejects.toThrow(/client credentials not configured/);
  });

  it('throws when CLIENT_SECRET is missing', async () => {
    const ctx = buildContext({ systemSecrets: { CLIENT_ID }, replaceSystemSecrets: true });
    await expect(refreshAccessToken(ctx)).rejects.toThrow(/client credentials not configured/);
  });

  it('throws when REFRESH_TOKEN is missing', async () => {
    const ctx = buildContext({ userSecrets: { ACCESS_TOKEN, REALM_ID, EXPIRY_DATE: FUTURE_EXPIRY }, replaceUserSecrets: true });
    await expect(refreshAccessToken(ctx)).rejects.toThrow(/account not connected/);
  });

  it('sends correct token refresh request', async () => {
    const ctx = buildContext();
    setupResponses({
      status: 200,
      body: { access_token: NEW_ACCESS_TOKEN, refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 },
    });
    const token = await refreshAccessToken(ctx);
    expect(token).toBe(NEW_ACCESS_TOKEN);
    expect(fetchLogs[0].url).toBe(TOKEN_URL);
    expect(fetchLogs[0].method).toBe('POST');
    expect(fetchLogs[0].headers['Authorization']).toMatch(/^Basic /);
    expect(fetchLogs[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(fetchLogs[0].body).toContain('grant_type=refresh_token');
    expect(fetchLogs[0].body).toContain(`refresh_token=${REFRESH_TOKEN}`);
  });

  it('persists new tokens via updateUserSecrets', async () => {
    let savedSecrets: Record<string, string> = {};
    const ctx = buildContext({
      updateUserSecrets: async (s) => { savedSecrets = s; },
    });
    setupResponses({
      status: 200,
      body: { access_token: NEW_ACCESS_TOKEN, refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 },
    });
    await refreshAccessToken(ctx);
    expect(savedSecrets.ACCESS_TOKEN).toBe(NEW_ACCESS_TOKEN);
    expect(savedSecrets.REFRESH_TOKEN).toBe('new-refresh');
    expect(savedSecrets.EXPIRY_DATE).toBeDefined();
  });

  it('throws on non-200 response from token endpoint', async () => {
    const ctx = buildContext();
    setupResponses({ status: 400, body: 'invalid_grant' });
    await expect(refreshAccessToken(ctx)).rejects.toThrow(/token refresh failed/);
  });

  it('throws when response has no access_token', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { token_type: 'Bearer', expires_in: 3600 } });
    await expect(refreshAccessToken(ctx)).rejects.toThrow(/no access token/);
  });
});

// =============================================================================
// quickbooksRequest TESTS
// =============================================================================

describe('quickbooksRequest', () => {
  it('constructs correct URL with production base', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: {} } });
    await quickbooksRequest('query?query=SELECT%20*%20FROM%20Customer', ctx, 'GET');
    expect(lastLog().url).toBe(`${PRODUCTION_BASE_URL}/${REALM_ID}/query?query=SELECT%20*%20FROM%20Customer`);
    expect(lastLog().method).toBe('GET');
    expect(lastLog().headers['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('constructs correct URL with sandbox base', async () => {
    const ctx = buildContext({ systemSecrets: { CLIENT_ID, CLIENT_SECRET, QUICKBOOKS_USE_SANDBOX: 'true' } });
    setupResponses({ status: 200, body: { QueryResponse: {} } });
    await quickbooksRequest('query?query=test', ctx, 'GET');
    expect(lastLog().url).toContain('sandbox-quickbooks');
  });

  it('sends JSON body for POST requests', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    const body = { DisplayName: 'Test' };
    await quickbooksRequest('customer', ctx, 'POST', body);
    expect(lastLog().method).toBe('POST');
    expect(lastLog().body).toBe(JSON.stringify(body));
    expect(lastLog().headers['Content-Type']).toBe('application/json');
  });

  it('does not send body for GET requests', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: {} });
    await quickbooksRequest('customer/123', ctx, 'GET', { unused: true });
    expect(lastLog().body).toBeNull();
  });

  it('throws when realmId is missing', async () => {
    const ctx = buildContext({ userSecrets: { ACCESS_TOKEN, REFRESH_TOKEN, EXPIRY_DATE: FUTURE_EXPIRY } , replaceUserSecrets: true });
    await expect(quickbooksRequest('customer', ctx, 'GET')).rejects.toThrow(/realmId.*not configured/);
  });

  it('handles 401 by refreshing token and retrying', async () => {
    const ctx = buildContext({
      userSecrets: { ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID, EXPIRY_DATE: FUTURE_EXPIRY },
    });
    setupResponses(
      { status: 401, body: { error: 'invalid_token' } },
      { status: 200, body: { access_token: NEW_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 } },
      { status: 200, body: { Customer: { Id: '1' } } },
    );
    const result = await quickbooksRequest('customer/1', ctx, 'GET');
    expect((result as any).Customer.Id).toBe('1');
    // 3 fetch calls: initial 401, token refresh, retry
    expect(fetchLogs).toHaveLength(3);
    // The retry should use the new token
    expect(fetchLogs[2].headers['Authorization']).toBe(`Bearer ${NEW_ACCESS_TOKEN}`);
  });

  it('throws on 401 after refresh already attempted', async () => {
    const ctx = buildContext({
      userSecrets: { ACCESS_TOKEN, REFRESH_TOKEN, REALM_ID, EXPIRY_DATE: FUTURE_EXPIRY },
    });
    setupResponses(
      { status: 401, body: { error: 'invalid_token' } },
      { status: 200, body: { access_token: NEW_ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 } },
      { status: 401, body: { error: 'still_invalid' } },
    );
    await expect(quickbooksRequest('customer/1', ctx, 'GET')).rejects.toThrow(/authentication failed after token refresh/);
  });

  it('handles 429 rate limit with retry', async () => {
    const ctx = buildContext();
    setupResponses(
      { status: 429, body: { error: 'rate_limited' }, headers: { 'Retry-After': '0' } },
      { status: 200, body: { Customer: { Id: '1' } } },
    );
    const result = await quickbooksRequest('customer/1', ctx, 'GET');
    expect((result as any).Customer.Id).toBe('1');
    expect(fetchLogs).toHaveLength(2);
  });

  it('throws on 404 not found', async () => {
    const ctx = buildContext();
    setupResponses({ status: 404, body: { Fault: { Error: [{ Message: 'Object not found' }] } } });
    await expect(quickbooksRequest('customer/999', ctx, 'GET')).rejects.toThrow(/API error 404.*Object not found/);
  });

  it('throws on 500 server error', async () => {
    const ctx = buildContext();
    setupResponses({ status: 500, body: 'Internal Server Error' });
    await expect(quickbooksRequest('customer/1', ctx, 'GET')).rejects.toThrow(/API error 500/);
  });

  it('parses QuickBooks Fault.Error message from error response', async () => {
    const ctx = buildContext();
    setupResponses({
      status: 400,
      body: { Fault: { Error: [{ Message: 'Duplicate display name' }] } },
    });
    await expect(quickbooksRequest('customer', ctx, 'POST', { DisplayName: 'Dup' })).rejects.toThrow(
      /Duplicate display name/,
    );
  });

  it('returns { success: true } for 204 No Content', async () => {
    const ctx = buildContext();
    setupResponses({ status: 204, body: '' });
    const result = await quickbooksRequest('payment?operation=delete', ctx, 'POST', { Id: '1' });
    expect(result).toEqual({ success: true });
  });
});

// =============================================================================
// FORMATTER TESTS
// =============================================================================

describe('formatCompanyInfo', () => {
  it('extracts fields from QueryResponse wrapper', () => {
    const data = {
      QueryResponse: {
        CompanyInfo: [{
          Id: '1',
          CompanyName: 'Test Corp',
          Country: 'US',
          Currency: { value: 'USD' },
          CompanyAddr: { Line1: '123 Main St', City: 'Austin', CountrySubDivisionCode: 'TX', PostalCode: '78701', Country: 'US' },
          Email: { Address: 'info@test.com' },
          PrimaryPhone: { FreeFormNumber: '555-1234' },
          WebAddr: { URI: 'https://test.com' },
        }],
      },
    };
    const result = formatCompanyInfo(data);
    expect(result.id).toBe('1');
    expect(result.name).toBe('Test Corp');
    expect(result.country).toBe('US');
    expect(result.currency).toBe('USD');
    expect(result.address?.line1).toBe('123 Main St');
    expect(result.address?.city).toBe('Austin');
    expect(result.address?.state).toBe('TX');
    expect(result.email).toBe('info@test.com');
    expect(result.phone).toBe('555-1234');
    expect(result.webAddr).toBe('https://test.com');
  });

  it('handles direct CompanyInfo response', () => {
    const data = { CompanyInfo: { Id: '2', CompanyName: 'Direct Co' } };
    const result = formatCompanyInfo(data);
    expect(result.id).toBe('2');
    expect(result.name).toBe('Direct Co');
  });

  it('returns nulls for missing fields', () => {
    const result = formatCompanyInfo({});
    expect(result.id).toBeNull();
    expect(result.name).toBeNull();
    expect(result.address).toBeNull();
    expect(result.legalAddress).toBeNull();
  });
});

describe('formatCustomer', () => {
  it('extracts all customer fields', () => {
    const c = {
      Id: '10',
      SyncToken: '3',
      DisplayName: 'Acme Corp',
      CompanyName: 'Acme Inc',
      GivenName: 'John',
      FamilyName: 'Doe',
      Active: true,
      FullyQualifiedName: 'Acme Corp',
      PrimaryEmailAddr: { Address: 'john@acme.com' },
      PrimaryPhone: { FreeFormNumber: '555-9999' },
      Balance: '150.00',
      BalanceWithJobs: '200.00',
      TotalRevenue: '5000.00',
      TotalExpense: '1000.00',
      BillAddr: { Line1: '1 Test St', City: 'Testville', CountrySubDivisionCode: 'CA', PostalCode: '90210', Country: 'US' },
      Notes: 'VIP customer',
      TaxIdentifier: 'EIN-123',
      CurrencyRef: { value: 'USD' },
    };
    const result = formatCustomer(c);
    expect(result.id).toBe('10');
    expect(result.syncToken).toBe('3');
    expect(result.displayName).toBe('Acme Corp');
    expect(result.companyName).toBe('Acme Inc');
    expect(result.givenName).toBe('John');
    expect(result.familyName).toBe('Doe');
    expect(result.active).toBe(true);
    expect(result.primaryEmail).toBe('john@acme.com');
    expect(result.primaryPhone).toBe('555-9999');
    expect(result.balance).toBe('150.00');
    expect(result.billAddr?.line1).toBe('1 Test St');
    expect(result.billAddr?.city).toBe('Testville');
    expect(result.billAddr?.state).toBe('CA');
    expect(result.notes).toBe('VIP customer');
    expect(result.currency).toBe('USD');
  });

  it('returns nulls for empty object', () => {
    const result = formatCustomer({});
    expect(result.id).toBeNull();
    expect(result.displayName).toBeNull();
    expect(result.billAddr).toBeNull();
  });
});

describe('formatVendor', () => {
  it('extracts vendor fields including webAddr and vendor1099', () => {
    const v = {
      Id: '20',
      SyncToken: '1',
      DisplayName: 'Supplier Co',
      Active: true,
      PrimaryEmailAddr: { Address: 'ap@supplier.com' },
      Balance: '500.00',
      Vendor1099: true,
      WebAddr: { URI: 'https://supplier.com' },
      CurrencyRef: { value: 'USD' },
    };
    const result = formatVendor(v);
    expect(result.id).toBe('20');
    expect(result.displayName).toBe('Supplier Co');
    expect(result.vendor1099).toBe(true);
    expect(result.webAddr).toBe('https://supplier.com');
    expect(result.balance).toBe('500.00');
    expect(result.currency).toBe('USD');
  });
});

describe('formatInvoice', () => {
  it('formats invoice with line items', () => {
    const inv = {
      Id: '100',
      SyncToken: '2',
      DocNumber: 'INV-001',
      TxnDate: '2026-09-20',
      DueDate: '2026-10-20',
      CustomerRef: { value: '10', name: 'Acme Corp' },
      TotalAmt: '500.00',
      Balance: '250.00',
      BillEmail: { Address: 'billing@acme.com' },
      EmailStatus: 'EmailSent',
      Line: [
        {
          Id: '1',
          Amount: 300,
          DetailType: 'SalesItemLineDetail',
          Description: 'Consulting',
          SalesItemLineDetail: {
            ItemRef: { value: '5', name: 'Consulting' },
            Qty: 3,
            UnitPrice: 100,
            TaxCodeRef: { value: 'NON' },
          },
        },
      ],
    };
    const result = formatInvoice(inv);
    expect(result.id).toBe('100');
    expect(result.docNumber).toBe('INV-001');
    expect(result.txnDate).toBe('2026-09-20');
    expect(result.dueDate).toBe('2026-10-20');
    expect(result.customerRef?.value).toBe('10');
    expect(result.customerRef?.name).toBe('Acme Corp');
    expect(result.totalAmt).toBe('500.00');
    expect(result.balance).toBe('250.00');
    expect(result.billEmail).toBe('billing@acme.com');
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].amount).toBe(300);
    expect(result.lineItems[0].detailType).toBe('SalesItemLineDetail');
    expect(result.lineItems[0].description).toBe('Consulting');
    expect(result.lineItems[0].itemId).toBe('5');
    expect(result.lineItems[0].itemName).toBe('Consulting');
    expect(result.lineItems[0].quantity).toBe(3);
    expect(result.lineItems[0].unitPrice).toBe(100);
  });

  it('handles invoice with no line items', () => {
    const result = formatInvoice({ Id: '1', TotalAmt: '0' });
    expect(result.lineItems).toEqual([]);
  });
});

describe('formatInvoiceLine', () => {
  it('handles line without SalesItemLineDetail', () => {
    const result = formatInvoiceLine({ Id: '1', Amount: 50, DetailType: 'DescriptionOnly' });
    expect(result.id).toBe('1');
    expect(result.amount).toBe(50);
    expect(result.detailType).toBe('DescriptionOnly');
    expect((result as any).itemId).toBeUndefined();
  });
});

describe('formatPayment', () => {
  it('formats payment with linked transactions', () => {
    const pmt = {
      Id: '200',
      SyncToken: '0',
      TxnDate: '2026-09-20',
      CustomerRef: { value: '10', name: 'Acme Corp' },
      TotalAmt: '250.00',
      UnappliedAmt: '0',
      PaymentMethodRef: { value: '1', name: 'Check' },
      Line: [
        {
          Amount: 250,
          LinkedTxn: [{ TxnId: '100', TxnType: 'Invoice' }],
        },
      ],
    };
    const result = formatPayment(pmt);
    expect(result.id).toBe('200');
    expect(result.totalAmt).toBe('250.00');
    expect(result.paymentMethodName).toBe('Check');
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].amount).toBe(250);
    expect(result.lineItems[0].linkedTxns).toHaveLength(1);
    expect(result.lineItems[0].linkedTxns[0].txnId).toBe('100');
    expect(result.lineItems[0].linkedTxns[0].txnType).toBe('Invoice');
  });
});

describe('formatPaymentLine', () => {
  it('handles line with no LinkedTxn', () => {
    const result = formatPaymentLine({ Amount: 100 });
    expect(result.amount).toBe(100);
    expect(result.linkedTxns).toEqual([]);
  });
});

describe('formatBill', () => {
  it('formats bill with expense line items', () => {
    const bill = {
      Id: '300',
      SyncToken: '1',
      TxnDate: '2026-09-20',
      DueDate: '2026-10-20',
      VendorRef: { value: '20', name: 'Supplier Co' },
      TotalAmt: '1000.00',
      Balance: '1000.00',
      APAccountRef: { value: '50' },
      DocNumber: 'BILL-001',
      Line: [
        {
          Id: '1',
          Amount: 1000,
          DetailType: 'AccountBasedExpenseLineDetail',
          Description: 'Office supplies',
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: '60', name: 'Office Supplies' },
            BillableStatus: 'Billable',
          },
        },
      ],
    };
    const result = formatBill(bill);
    expect(result.id).toBe('300');
    expect(result.docNumber).toBe('BILL-001');
    expect(result.vendorRef?.value).toBe('20');
    expect(result.vendorRef?.name).toBe('Supplier Co');
    expect(result.totalAmt).toBe('1000.00');
    expect(result.payableAccountRef).toBe('50');
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].amount).toBe(1000);
    expect(result.lineItems[0].accountId).toBe('60');
    expect(result.lineItems[0].accountName).toBe('Office Supplies');
    expect(result.lineItems[0].billableStatus).toBe('Billable');
  });
});

describe('formatBillLine', () => {
  it('handles line without AccountBasedExpenseLineDetail', () => {
    const result = formatBillLine({ Id: '1', Amount: 50, DetailType: 'Other' });
    expect(result.id).toBe('1');
    expect(result.amount).toBe(50);
    expect((result as any).accountId).toBeUndefined();
  });
});

describe('formatAccount', () => {
  it('extracts account fields', () => {
    const acct = {
      Id: '40',
      SyncToken: '0',
      Name: 'Checking',
      FullyQualifiedName: 'Checking',
      AccountType: 'Asset',
      AccountSubType: 'Bank',
      Classification: 'Asset',
      Active: true,
      CurrentBalance: '5000.00',
      CurrencyRef: { value: 'USD' },
      AcctNum: '1000',
    };
    const result = formatAccount(acct);
    expect(result.id).toBe('40');
    expect(result.name).toBe('Checking');
    expect(result.accountType).toBe('Asset');
    expect(result.accountSubType).toBe('Bank');
    expect(result.classification).toBe('Asset');
    expect(result.currentBalance).toBe('5000.00');
    expect(result.accountNumber).toBe('1000');
    expect(result.currencyRef).toBe('USD');
  });
});

describe('formatItem', () => {
  it('extracts item fields', () => {
    const item = {
      Id: '50',
      SyncToken: '0',
      Name: 'Consulting',
      FullyQualifiedName: 'Consulting',
      Type: 'Service',
      Active: true,
      UnitPrice: 150,
      Taxable: true,
      IncomeAccountRef: { value: '70', name: 'Services Revenue' },
      Sku: 'CONS-001',
    };
    const result = formatItem(item);
    expect(result.id).toBe('50');
    expect(result.name).toBe('Consulting');
    expect(result.type).toBe('Service');
    expect(result.unitPrice).toBe(150);
    expect(result.taxable).toBe(true);
    expect(result.incomeAccountRef).toBe('70');
    expect(result.incomeAccountName).toBe('Services Revenue');
    expect(result.sku).toBe('CONS-001');
  });
});

describe('extractQueryResults', () => {
  it('returns array from QueryResponse', () => {
    const data = { QueryResponse: { Customer: [{ Id: '1' }, { Id: '2' }] } };
    expect(extractQueryResults(data, 'Customer')).toHaveLength(2);
  });

  it('wraps single object in array', () => {
    const data = { QueryResponse: { Customer: { Id: '1' } } };
    expect(extractQueryResults(data, 'Customer')).toHaveLength(1);
  });

  it('returns empty array when key is missing', () => {
    expect(extractQueryResults({ QueryResponse: {} }, 'Customer')).toEqual([]);
  });

  it('returns empty array when QueryResponse is missing', () => {
    expect(extractQueryResults({}, 'Customer')).toEqual([]);
  });
});

// =============================================================================
// REPORT FORMATTER TESTS
// =============================================================================

describe('formatReport', () => {
  it('formats a complete report response', () => {
    const data = {
      Header: { ReportName: 'ProfitAndLoss', Time: '2026-09-20T10:00:00', StartPeriod: '2026-01-01', EndPeriod: '2026-09-30', Currency: 'USD' },
      Columns: { Column: [{ ColTitle: 'Total', ColType: 'Money' }, { ColTitle: 'Amount', ColType: 'Money' }] },
      Rows: {
        Row: [
          { type: 'Section', Header: { ColData: [{ value: 'Income' }] }, Summary: { ColData: [{ value: 'Total Income' }, { value: '5000.00' }] } },
          { type: 'Data', ColData: [{ value: 'Consulting' }, { value: '5000.00' }] },
        ],
      },
    };
    const result = formatReport(data);
    expect(result.header.reportName).toBe('ProfitAndLoss');
    expect(result.header.startPeriod).toBe('2026-01-01');
    expect(result.header.endPeriod).toBe('2026-09-30');
    expect(result.header.currency).toBe('USD');
    expect(result.columns).toHaveLength(2);
    expect(result.columns[0].title).toBe('Total');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].type).toBe('Section');
    expect(result.rows[0].header[0].value).toBe('Income');
    expect(result.rows[0].summary[1].value).toBe('5000.00');
    expect(result.rows[1].type).toBe('Data');
    expect(result.rows[1].colData[1].value).toBe('5000.00');
  });

  it('handles empty report', () => {
    const result = formatReport({});
    expect(result.header.reportName).toBeNull();
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('handles nested rows recursively', () => {
    const data = {
      Rows: {
        Row: [
          {
            type: 'Section',
            Rows: {
              Row: [{ type: 'Data', ColData: [{ value: 'Nested' }] }],
            },
          },
        ],
      },
    };
    const result = formatReport(data);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rows).toHaveLength(1);
    expect(result.rows[0].rows[0].colData[0].value).toBe('Nested');
  });
});

describe('extractPLSummary', () => {
  it('extracts total income, expenses, and net income', () => {
    const data = {
      Rows: {
        Row: [
          { Summary: { ColData: [{ value: 'Total Income' }, { value: '10000.00' }] } },
          { Summary: { ColData: [{ value: 'Total Cost of Goods Sold' }, { value: '2000.00' }] } },
          { Summary: { ColData: [{ value: 'Total Expense' }, { value: '3000.00' }] } },
          { Summary: { ColData: [{ value: 'Net Income' }, { value: '5000.00' }] } },
        ],
      },
    };
    const result = extractPLSummary(data) as any;
    expect(result.totalIncome).toBe(10000);
    expect(result.totalExpenses).toBe(5000); // 2000 + 3000
    expect(result.netIncome).toBe(5000);
  });

  it('returns nulls when no matching rows', () => {
    const result = extractPLSummary({ Rows: { Row: [] } }) as any;
    expect(result.totalIncome).toBeNull();
    expect(result.totalExpenses).toBeNull();
    expect(result.netIncome).toBeNull();
  });
});

describe('extractAgingBuckets', () => {
  it('extracts aging bucket amounts from columns and summary', () => {
    const data = {
      Columns: { Column: [
        { ColTitle: 'Customer' },
        { ColTitle: 'Current' },
        { ColTitle: '1-30' },
        { ColTitle: '31-60' },
        { ColTitle: '61-90' },
        { ColTitle: '91+' },
        { ColTitle: 'Total' },
      ] },
      Rows: { Summary: { ColData: [
        { value: 'Total' },
        { value: '1000.00' },
        { value: '500.00' },
        { value: '200.00' },
        { value: '100.00' },
        { value: '50.00' },
        { value: '1850.00' },
      ] } },
    };
    const result = extractAgingBuckets(data) as any;
    expect(result.buckets.Current).toBe(1000);
    expect(result.buckets['1-30']).toBe(500);
    expect(result.buckets['31-60']).toBe(200);
    expect(result.buckets['61-90']).toBe(100);
    expect(result.buckets['91+']).toBe(50);
    expect(result.buckets.Total).toBe(1850);
  });
});

// =============================================================================
// TOOL HANDLER TESTS — get-company-info
// =============================================================================

describe('get-company-info tool', () => {
  it('sends GET request to CompanyInfo query endpoint', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { CompanyInfo: [{ Id: '1', CompanyName: 'Test' }] } } });
    const result = await getCompanyInfo.handler!({}, ctx);
    expect(lastLog().url).toContain('/query?query=');
    expect(lastLog().method).toBe('GET');
    expect((result as any).name).toBe('Test');
  });
});

// =============================================================================
// TOOL HANDLER TESTS — CUSTOMERS
// =============================================================================

describe('list-customers tool', () => {
  it('sends query with no filters by default', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [], maxResults: 0, startPosition: 1 } } });
    await listCustomers.handler!({}, ctx);
    const url = lastLog().url;
    const decoded = decodeURIComponent(url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Customer');
    expect(decoded).not.toContain('WHERE');
    expect(decoded).toContain('STARTPOSITION 1');
    expect(decoded).toContain('MAXRESULTS 50');
  });

  it('builds WHERE clause with query filter', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ query: 'Acme' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("DisplayName LIKE '%Acme%'");
  });

  it('builds WHERE clause with active filter', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ active: true }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('Active = true');
  });

  it('combines query and active filters with AND', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ query: 'Test', active: false }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("DisplayName LIKE '%Test%'");
    expect(decoded).toContain('Active = false');
    expect(decoded).toContain(' AND ');
  });

  it('applies pagination with limit and offset', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ limit: 10, offset: 21 }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('STARTPOSITION 21');
    expect(decoded).toContain('MAXRESULTS 10');
  });

  it('clamps limit to max 100', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ limit: 500 }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('MAXRESULTS 100');
  });

  it('clamps offset to min 1', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ offset: 0 }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('STARTPOSITION 1');
  });

  it('escapes single quotes in query parameter', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Customer: [] } } });
    await listCustomers.handler!({ query: "O'Brien" }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("O''Brien");
  });

  it('returns formatted customer list with count', async () => {
    const ctx = buildContext();
    setupResponses({
      status: 200,
      body: {
        QueryResponse: {
          Customer: [{ Id: '1', DisplayName: 'A' }, { Id: '2', DisplayName: 'B' }],
          maxResults: 2,
          startPosition: 1,
          totalCount: 5,
        },
      },
    });
    const result = await listCustomers.handler!({}, ctx) as any;
    expect(result.customers).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.startPosition).toBe(1);
    expect(result.maxResults).toBe(2);
    expect(result.totalCount).toBe(5);
  });

  it('returns empty list when QueryResponse has no Customer key', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: {} } });
    const result = await listCustomers.handler!({}, ctx) as any;
    expect(result.customers).toEqual([]);
    expect(result.count).toBe(0);
  });
});

describe('get-customer tool', () => {
  it('sends GET to customer/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: { Id: '10', DisplayName: 'Test' } } });
    const result = await getCustomer.handler!({ customerId: '10' }, ctx) as any;
    expect(lastLog().url).toContain('/customer/10');
    expect(lastLog().method).toBe('GET');
    expect(result.id).toBe('10');
    expect(result.displayName).toBe('Test');
  });
});

describe('create-customer tool', () => {
  it('builds POST body with DisplayName', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: { Id: '1', DisplayName: 'Test Corp' } } });
    await createCustomer.handler!({ displayName: 'Test Corp' }, ctx);
    expect(lastLog().url).toContain('/customer');
    expect(lastLog().method).toBe('POST');
    const body = JSON.parse(lastLog().body!);
    expect(body.DisplayName).toBe('Test Corp');
  });

  it('maps email to PrimaryEmailAddr', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    await createCustomer.handler!({ displayName: 'T', email: 'test@test.com' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.PrimaryEmailAddr).toEqual({ Address: 'test@test.com' });
  });

  it('maps phone to PrimaryPhone', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    await createCustomer.handler!({ displayName: 'T', phone: '555-1234' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.PrimaryPhone).toEqual({ FreeFormNumber: '555-1234' });
  });

  it('maps billAddr directly', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    const addr = { Line1: '1 St', City: 'Austin' };
    await createCustomer.handler!({ displayName: 'T', billAddr: addr }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.BillAddr).toEqual(addr);
  });

  it('omits optional fields when not provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    await createCustomer.handler!({ displayName: 'T' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.DisplayName).toBe('T');
    expect(body.PrimaryEmailAddr).toBeUndefined();
    expect(body.PrimaryPhone).toBeUndefined();
    expect(body.BillAddr).toBeUndefined();
  });
});

describe('update-customer tool', () => {
  it('builds sparse update with Id and SyncToken', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: { Id: '10', SyncToken: '4' } } });
    await updateCustomer.handler!({ customerId: '10', syncToken: '3', displayName: 'Updated' }, ctx);
    expect(lastLog().method).toBe('POST');
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('10');
    expect(body.SyncToken).toBe('3');
    expect(body.sparse).toBe(true);
    expect(body.DisplayName).toBe('Updated');
  });

  it('sets active=false for deactivation', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: { Id: '10', Active: false } } });
    await updateCustomer.handler!({ customerId: '10', syncToken: '3', active: false }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Active).toBe(false);
  });

  it('omits undefined fields (sparse update)', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Customer: {} } });
    await updateCustomer.handler!({ customerId: '10', syncToken: '3', email: 'new@test.com' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.PrimaryEmailAddr).toEqual({ Address: 'new@test.com' });
    expect(body.DisplayName).toBeUndefined();
    expect(body.Active).toBeUndefined();
  });
});

// =============================================================================
// TOOL HANDLER TESTS — VENDORS
// =============================================================================

describe('list-vendors tool', () => {
  it('sends query to Vendor entity', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Vendor: [] } } });
    await listVendors.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Vendor');
  });

  it('applies query and active filters', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Vendor: [] } } });
    await listVendors.handler!({ query: 'Supp', active: true }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("DisplayName LIKE '%Supp%'");
    expect(decoded).toContain('Active = true');
  });
});

describe('get-vendor tool', () => {
  it('sends GET to vendor/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Vendor: { Id: '20', DisplayName: 'Supp' } } });
    const result = await getVendor.handler!({ vendorId: '20' }, ctx) as any;
    expect(lastLog().url).toContain('/vendor/20');
    expect(result.id).toBe('20');
  });
});

describe('create-vendor tool', () => {
  it('maps webAddr to WebAddr.URI', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Vendor: {} } });
    await createVendor.handler!({ displayName: 'Supp', webAddr: 'https://supp.com' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.WebAddr).toEqual({ URI: 'https://supp.com' });
  });
});

describe('update-vendor tool', () => {
  it('builds sparse update with Id and SyncToken', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Vendor: {} } });
    await updateVendor.handler!({ vendorId: '20', syncToken: '1', active: false }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('20');
    expect(body.SyncToken).toBe('1');
    expect(body.sparse).toBe(true);
    expect(body.Active).toBe(false);
  });
});

// =============================================================================
// TOOL HANDLER TESTS — INVOICES
// =============================================================================

describe('list-invoices tool', () => {
  it('sends query to Invoice entity with ORDERBY TxnDate DESCENDING', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Invoice');
    expect(decoded).toContain('ORDERBY TxnDate DESCENDING');
  });

  it('filters by customerId', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ customerId: '10' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("CustomerRef = '10'");
  });

  it('filters by status=open (Balance > 0)', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ status: 'open' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("Balance > '0'");
  });

  it('filters by status=paid (Balance = 0)', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ status: 'paid' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("Balance = '0'");
  });

  it('filters by status=void (TotalAmt=0 AND Balance=0)', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ status: 'void' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("TotalAmt = '0' AND Balance = '0'");
  });

  it('does not add status filter for status=all', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ status: 'all' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).not.toContain('Balance');
  });

  it('filters by date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Invoice: [] } } });
    await listInvoices.handler!({ dateFrom: '2026-01-01', dateTo: '2026-09-30' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("TxnDate >= '2026-01-01'");
    expect(decoded).toContain("TxnDate <= '2026-09-30'");
  });
});

describe('get-invoice tool', () => {
  it('sends GET to invoice/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: { Id: '100', DocNumber: 'INV-1' } } });
    const result = await getInvoice.handler!({ invoiceId: '100' }, ctx) as any;
    expect(lastLog().url).toContain('/invoice/100');
    expect(result.id).toBe('100');
    expect(result.docNumber).toBe('INV-1');
  });
});

describe('create-invoice tool', () => {
  it('builds invoice with CustomerRef and Line items', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: { Id: '1' } } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 2, unitPrice: 100 }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.CustomerRef).toEqual({ value: '10' });
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBe(200);
    expect(body.Line[0].DetailType).toBe('SalesItemLineDetail');
    expect(body.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: '5' });
    expect(body.Line[0].SalesItemLineDetail.Qty).toBe(2);
    expect(body.Line[0].SalesItemLineDetail.UnitPrice).toBe(100);
  });

  it('calculates Amount as quantity * unitPrice', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 3, unitPrice: 50 }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line[0].Amount).toBe(150);
  });

  it('includes description when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 1, unitPrice: 100, description: 'Consulting' }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line[0].Description).toBe('Consulting');
  });

  it('sets billEmail when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 1, unitPrice: 100 }],
      billEmail: 'billing@test.com',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.BillEmail).toEqual({ Address: 'billing@test.com' });
  });

  it('sets customerMemo when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 1, unitPrice: 100 }],
      customerMemo: 'Thanks!',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.CustomerMemo).toEqual({ value: 'Thanks!' });
  });

  it('defaults TxnDate to today when not provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await createInvoice.handler!({
      customerId: '10',
      lineItems: [{ itemId: '5', quantity: 1, unitPrice: 100 }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    const today = new Date().toISOString().split('T')[0];
    expect(body.TxnDate).toBe(today);
  });
});

describe('update-invoice tool', () => {
  it('builds sparse update with Id and SyncToken', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await updateInvoice.handler!({ invoiceId: '100', syncToken: '2', txnDate: '2026-09-21' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('100');
    expect(body.SyncToken).toBe('2');
    expect(body.sparse).toBe(true);
    expect(body.TxnDate).toBe('2026-09-21');
  });

  it('replaces line items when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await updateInvoice.handler!({
      invoiceId: '100',
      syncToken: '2',
      lineItems: [{ itemId: '6', quantity: 1, unitPrice: 200 }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBe(200);
    expect(body.Line[0].SalesItemLineDetail.ItemRef).toEqual({ value: '6' });
  });
});

describe('void-invoice tool', () => {
  it('sends POST to invoice?operation=void with Id and SyncToken', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: { Id: '100', SyncToken: '3', TotalAmt: '0', Balance: '0' } } });
    const result = await voidInvoice.handler!({ invoiceId: '100', syncToken: '2' }, ctx) as any;
    expect(lastLog().url).toContain('invoice?operation=void');
    expect(lastLog().method).toBe('POST');
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('100');
    expect(body.SyncToken).toBe('2');
    expect(result.voided).toBe(true);
    expect(result.id).toBe('100');
  });

  it('returns voided=true with fallback id when response is empty', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: {} });
    const result = await voidInvoice.handler!({ invoiceId: '999', syncToken: '0' }, ctx) as any;
    expect(result.voided).toBe(true);
    expect(result.id).toBe('999');
    expect(result.totalAmt).toBe(0);
    expect(result.balance).toBe(0);
  });
});

describe('send-invoice tool', () => {
  it('sends POST to invoice/{id}/send without email param', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: { Id: '100', EmailStatus: 'EmailSent' } } });
    const result = await sendInvoice.handler!({ invoiceId: '100' }, ctx) as any;
    expect(lastLog().url).toContain('/invoice/100/send');
    expect(lastLog().method).toBe('POST');
    expect(lastLog().url).not.toContain('sendTo=');
    expect(result.sent).toBe(true);
    expect(result.emailStatus).toBe('EmailSent');
  });

  it('appends sendTo query param when email is provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Invoice: {} } });
    await sendInvoice.handler!({ invoiceId: '100', email: 'cust@test.com' }, ctx);
    expect(lastLog().url).toContain('sendTo=cust%40test.com');
  });
});

// =============================================================================
// TOOL HANDLER TESTS — PAYMENTS
// =============================================================================

describe('list-payments tool', () => {
  it('sends query to Payment entity', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Payment: [] } } });
    await listPayments.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Payment');
    expect(decoded).toContain('ORDERBY TxnDate DESCENDING');
  });

  it('filters by customerId and date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Payment: [] } } });
    await listPayments.handler!({ customerId: '10', dateFrom: '2026-01-01', dateTo: '2026-06-30' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("CustomerRef = '10'");
    expect(decoded).toContain("TxnDate >= '2026-01-01'");
    expect(decoded).toContain("TxnDate <= '2026-06-30'");
  });
});

describe('get-payment tool', () => {
  it('sends GET to payment/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: { Id: '200', TotalAmt: '100' } } });
    const result = await getPayment.handler!({ paymentId: '200' }, ctx) as any;
    expect(lastLog().url).toContain('/payment/200');
    expect(result.id).toBe('200');
  });
});

describe('create-payment tool', () => {
  it('builds payment with CustomerRef and TotalAmt', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: { Id: '1' } } });
    await createPayment.handler!({ customerId: '10', totalAmt: 250 }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.CustomerRef).toEqual({ value: '10' });
    expect(body.TotalAmt).toBe(250);
  });

  it('links to invoice via LinkedTxn when invoiceId provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: {} } });
    await createPayment.handler!({ customerId: '10', totalAmt: 250, invoiceId: '100' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBe(250);
    expect(body.Line[0].LinkedTxn).toEqual([{ TxnId: '100', TxnType: 'Invoice' }]);
  });

  it('does not add Line when invoiceId is not provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: {} } });
    await createPayment.handler!({ customerId: '10', totalAmt: 100 }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line).toBeUndefined();
  });

  it('maps payment method to PaymentMethodRef.name', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: {} } });
    await createPayment.handler!({ customerId: '10', totalAmt: 100, paymentMethod: 'credit_card' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.PaymentMethodRef).toEqual({ name: 'Credit Card' });
  });

  it('maps cash payment method', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: {} } });
    await createPayment.handler!({ customerId: '10', totalAmt: 100, paymentMethod: 'cash' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.PaymentMethodRef).toEqual({ name: 'Cash' });
  });

  it('defaults TxnDate to today', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Payment: {} } });
    await createPayment.handler!({ customerId: '10', totalAmt: 100 }, ctx);
    const body = JSON.parse(lastLog().body!);
    const today = new Date().toISOString().split('T')[0];
    expect(body.TxnDate).toBe(today);
  });
});

describe('delete-payment tool', () => {
  it('sends POST to payment?operation=delete with Id and SyncToken', async () => {
    const ctx = buildContext();
    setupResponses({ status: 204, body: '' });
    const result = await deletePayment.handler!({ paymentId: '200', syncToken: '1' }, ctx) as any;
    expect(lastLog().url).toContain('payment?operation=delete');
    expect(lastLog().method).toBe('POST');
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('200');
    expect(body.SyncToken).toBe('1');
    expect(result.deleted).toBe(true);
    expect(result.id).toBe('200');
  });
});

// =============================================================================
// TOOL HANDLER TESTS — BILLS
// =============================================================================

describe('list-bills tool', () => {
  it('sends query to Bill entity', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Bill: [] } } });
    await listBills.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Bill');
    expect(decoded).toContain('ORDERBY TxnDate DESCENDING');
  });

  it('filters by vendorId and status', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Bill: [] } } });
    await listBills.handler!({ vendorId: '20', status: 'open' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("VendorRef = '20'");
    expect(decoded).toContain("Balance > '0'");
  });

  it('filters by status=paid', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Bill: [] } } });
    await listBills.handler!({ status: 'paid' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("Balance = '0'");
  });
});

describe('get-bill tool', () => {
  it('sends GET to bill/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Bill: { Id: '300', TotalAmt: '1000' } } });
    const result = await getBill.handler!({ billId: '300' }, ctx) as any;
    expect(lastLog().url).toContain('/bill/300');
    expect(result.id).toBe('300');
  });
});

describe('create-bill tool', () => {
  it('builds bill with VendorRef and AccountBasedExpenseLineDetail', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Bill: { Id: '1' } } });
    await createBill.handler!({
      vendorId: '20',
      lineItems: [{ accountId: '60', amount: 500 }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.VendorRef).toEqual({ value: '20' });
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBe(500);
    expect(body.Line[0].DetailType).toBe('AccountBasedExpenseLineDetail');
    expect(body.Line[0].AccountBasedExpenseLineDetail.AccountRef).toEqual({ value: '60' });
  });

  it('includes description in line items when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Bill: {} } });
    await createBill.handler!({
      vendorId: '20',
      lineItems: [{ accountId: '60', amount: 500, description: 'Office supplies' }],
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Line[0].Description).toBe('Office supplies');
  });

  it('sets TxnDate and DueDate when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Bill: {} } });
    await createBill.handler!({
      vendorId: '20',
      lineItems: [{ accountId: '60', amount: 500 }],
      txnDate: '2026-09-20',
      dueDate: '2026-10-20',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.TxnDate).toBe('2026-09-20');
    expect(body.DueDate).toBe('2026-10-20');
  });
});

describe('update-bill tool', () => {
  it('builds update with Id, SyncToken, and optional fields', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Bill: {} } });
    await updateBill.handler!({
      billId: '300',
      syncToken: '1',
      privateNote: 'Updated note',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('300');
    expect(body.SyncToken).toBe('1');
    expect(body.PrivateNote).toBe('Updated note');
  });
});

describe('delete-bill tool', () => {
  it('sends POST to bill?operation=delete', async () => {
    const ctx = buildContext();
    setupResponses({ status: 204, body: '' });
    const result = await deleteBill.handler!({ billId: '300', syncToken: '1' }, ctx) as any;
    expect(lastLog().url).toContain('bill?operation=delete');
    const body = JSON.parse(lastLog().body!);
    expect(body.Id).toBe('300');
    expect(result.deleted).toBe(true);
  });
});

// =============================================================================
// TOOL HANDLER TESTS — ACCOUNTS
// =============================================================================

describe('list-accounts tool', () => {
  it('sends query to Account entity with ORDERBY Name', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Account: [] } } });
    await listAccounts.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Account');
    expect(decoded).toContain('ORDERBY Name');
  });

  it('filters by accountType', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Account: [] } } });
    await listAccounts.handler!({ accountType: 'Asset' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("AccountType = 'Asset'");
  });

  it('filters by active status', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Account: [] } } });
    await listAccounts.handler!({ active: true }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('Active = true');
  });
});

describe('get-account tool', () => {
  it('sends GET to account/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Account: { Id: '40', Name: 'Checking' } } });
    const result = await getAccount.handler!({ accountId: '40' }, ctx) as any;
    expect(lastLog().url).toContain('/account/40');
    expect(result.id).toBe('40');
    expect(result.name).toBe('Checking');
  });
});

describe('create-account tool', () => {
  it('builds account with Name and AccountType', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Account: { Id: '1' } } });
    await createAccount.handler!({ name: 'Office Supplies', accountType: 'Expense' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Name).toBe('Office Supplies');
    expect(body.AccountType).toBe('Expense');
  });

  it('includes optional fields when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Account: {} } });
    await createAccount.handler!({
      name: 'Checking',
      accountType: 'Asset',
      accountSubType: 'Bank',
      currency: 'USD',
      description: 'Main checking',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.AccountSubType).toBe('Bank');
    expect(body.CurrencyRef).toEqual({ value: 'USD' });
    expect(body.Description).toBe('Main checking');
  });
});

// =============================================================================
// TOOL HANDLER TESTS — ITEMS
// =============================================================================

describe('list-items tool', () => {
  it('sends query to Item entity with ORDERBY Name', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Item: [] } } });
    await listItems.handler!({}, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain('SELECT * FROM Item');
    expect(decoded).toContain('ORDERBY Name');
  });

  it('filters by type', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { QueryResponse: { Item: [] } } });
    await listItems.handler!({ type: 'Service' }, ctx);
    const decoded = decodeURIComponent(lastLog().url.split('query=')[1]);
    expect(decoded).toContain("Type = 'Service'");
  });
});

describe('get-item tool', () => {
  it('sends GET to item/{id}', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Item: { Id: '50', Name: 'Consulting' } } });
    const result = await getItem.handler!({ itemId: '50' }, ctx) as any;
    expect(lastLog().url).toContain('/item/50');
    expect(result.id).toBe('50');
    expect(result.name).toBe('Consulting');
  });
});

describe('create-item tool', () => {
  it('builds item with Name, Type, and IncomeAccountRef', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Item: { Id: '1' } } });
    await createItem.handler!({ name: 'Consulting', type: 'Service', incomeAccountRef: '70' }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.Name).toBe('Consulting');
    expect(body.Type).toBe('Service');
    expect(body.IncomeAccountRef).toEqual({ value: '70' });
  });

  it('includes optional fields when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Item: {} } });
    await createItem.handler!({
      name: 'Widget',
      type: 'Inventory',
      incomeAccountRef: '70',
      unitPrice: 25.50,
      expenseAccountRef: '80',
      sku: 'WID-001',
      taxable: true,
      description: 'A widget',
    }, ctx);
    const body = JSON.parse(lastLog().body!);
    expect(body.UnitPrice).toBe(25.50);
    expect(body.ExpenseAccountRef).toEqual({ value: '80' });
    expect(body.Sku).toBe('WID-001');
    expect(body.Taxable).toBe(true);
    expect(body.Description).toBe('A widget');
  });
});

// =============================================================================
// TOOL HANDLER TESTS — REPORTS
// =============================================================================

describe('report-profit-loss tool', () => {
  it('sends GET to reports/ProfitAndLoss with date params', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: { ReportName: 'ProfitAndLoss' }, Columns: { Column: [] }, Rows: { Row: [] } } });
    await reportProfitLoss.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/ProfitAndLoss');
    expect(lastLog().url).toContain('start_date=2026-01-01');
    expect(lastLog().url).toContain('end_date=2026-09-30');
    expect(lastLog().url).toContain('accounting_method=accrual');
  });

  it('defaults to accrual accounting method', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportProfitLoss.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('accounting_method=accrual');
  });

  it('uses cash accounting method when specified', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportProfitLoss.handler!({ startDate: '2026-01-01', endDate: '2026-09-30', accountingMethod: 'cash' }, ctx);
    expect(lastLog().url).toContain('accounting_method=cash');
  });

  it('returns formatted report with summary', async () => {
    const ctx = buildContext();
    setupResponses({
      status: 200,
      body: {
        Header: { ReportName: 'ProfitAndLoss' },
        Columns: { Column: [{ ColTitle: 'Total', ColType: 'Money' }] },
        Rows: {
          Row: [
            { Summary: { ColData: [{ value: 'Total Income' }, { value: '10000.00' }] } },
            { Summary: { ColData: [{ value: 'Net Income' }, { value: '5000.00' }] } },
          ],
        },
      },
    });
    const result = await reportProfitLoss.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx) as any;
    expect(result.header.reportName).toBe('ProfitAndLoss');
    expect(result.summary.totalIncome).toBe(10000);
    expect(result.summary.netIncome).toBe(5000);
  });
});

describe('report-balance-sheet tool', () => {
  it('sends GET to reports/BalanceSheet with date param', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportBalanceSheet.handler!({ date: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/BalanceSheet');
    expect(lastLog().url).toContain('date=2026-09-30');
  });

  it('supports accounting method', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportBalanceSheet.handler!({ date: '2026-09-30', accountingMethod: 'cash' }, ctx);
    expect(lastLog().url).toContain('accounting_method=cash');
  });
});

describe('report-cash-flow tool', () => {
  it('sends GET to reports/CashFlow with date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportCashFlow.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/CashFlow');
    expect(lastLog().url).toContain('start_date=2026-01-01');
    expect(lastLog().url).toContain('end_date=2026-09-30');
  });
});

describe('report-aged-receivables tool', () => {
  it('sends GET to reports/AgedReceivables with date', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: { Column: [] }, Rows: { Summary: { ColData: [] } } } });
    const result = await reportAgedReceivables.handler!({ date: '2026-09-30' }, ctx) as any;
    expect(lastLog().url).toContain('reports/AgedReceivables');
    expect(lastLog().url).toContain('date=2026-09-30');
    expect(result.aging).toBeDefined();
  });
});

describe('report-aged-payables tool', () => {
  it('sends GET to reports/AgedPayables with date', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: { Column: [] }, Rows: { Summary: { ColData: [] } } } });
    const result = await reportAgedPayables.handler!({ date: '2026-09-30' }, ctx) as any;
    expect(lastLog().url).toContain('reports/AgedPayables');
    expect(result.aging).toBeDefined();
  });
});

describe('report-trial-balance tool', () => {
  it('sends GET to reports/TrialBalance with date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportTrialBalance.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/TrialBalance');
    expect(lastLog().url).toContain('start_date=2026-01-01');
  });
});

describe('report-general-ledger tool', () => {
  it('sends GET to reports/GeneralLedger with date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportGeneralLedger.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/GeneralLedger');
    expect(lastLog().url).toContain('start_date=2026-01-01');
  });

  it('appends account_type when provided', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportGeneralLedger.handler!({ startDate: '2026-01-01', endDate: '2026-09-30', accountType: 'Asset' }, ctx);
    expect(lastLog().url).toContain('account_type=Asset');
  });
});

describe('report-customer-balance tool', () => {
  it('sends GET to reports/CustomerBalance with date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportCustomerBalance.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/CustomerBalance');
  });
});

describe('report-sales-by-customer tool', () => {
  it('sends GET to reports/SalesByCustomer with date range', async () => {
    const ctx = buildContext();
    setupResponses({ status: 200, body: { Header: {}, Columns: {}, Rows: {} } });
    await reportSalesByCustomer.handler!({ startDate: '2026-01-01', endDate: '2026-09-30' }, ctx);
    expect(lastLog().url).toContain('reports/SalesByCustomer');
  });
});

// =============================================================================
// CONSTANTS TESTS
// =============================================================================

describe('constants', () => {
  it('TOKEN_REFRESH_BUFFER_MS is 5 minutes', () => {
    expect(TOKEN_REFRESH_BUFFER_MS).toBe(5 * 60 * 1000);
  });

  it('RATE_LIMIT_BACKOFF_MS is 1 second', () => {
    expect(RATE_LIMIT_BACKOFF_MS).toBe(1000);
  });

  it('PRODUCTION_BASE_URL is the intuit production endpoint', () => {
    expect(PRODUCTION_BASE_URL).toBe('https://quickbooks.api.intuit.com/v3/company');
  });

  it('SANDBOX_BASE_URL is the intuit sandbox endpoint', () => {
    expect(SANDBOX_BASE_URL).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company');
  });

  it('TOKEN_URL is the intuit OAuth token endpoint', () => {
    expect(TOKEN_URL).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
  });
});
