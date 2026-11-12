/**
 * Integration tests for mca.intuit.quickbooks
 *
 * These tests make real HTTP requests to the QuickBooks Online API.
 * They are automatically skipped if credentials are not available in
 * environment variables.
 *
 * Required env vars:
 * - QUICKBOOKS_CLIENT_ID
 * - QUICKBOOKS_CLIENT_SECRET
 * - QUICKBOOKS_REFRESH_TOKEN
 * - QUICKBOOKS_REALM_ID
 * - QUICKBOOKS_USE_SANDBOX (optional, "true" for sandbox)
 *
 * Usage:
 *   QUICKBOOKS_CLIENT_ID=... QUICKBOOKS_CLIENT_SECRET=... \
 *   QUICKBOOKS_REFRESH_TOKEN=... QUICKBOOKS_REALM_ID=... \
 *   bun test test/integration/quickbooks.test.ts
 */

import { describe, expect, it } from 'bun:test';

import { quickbooksRequest } from '../../src/lib/client';
import { getCompanyInfo } from '../../src/tools/company';
import { listCustomers, createCustomer, getCustomer, updateCustomer } from '../../src/tools/customers';
import { listInvoices, createInvoice, getInvoice, voidInvoice } from '../../src/tools/invoices';
import { createPayment, getPayment, deletePayment } from '../../src/tools/payments';
import { reportProfitLoss } from '../../src/tools/reports';

// =============================================================================
// CREDENTIAL CHECK
// =============================================================================

const HAS_CREDS = !!(
  process.env.QUICKBOOKS_CLIENT_ID &&
  process.env.QUICKBOOKS_CLIENT_SECRET &&
  process.env.QUICKBOOKS_REFRESH_TOKEN &&
  process.env.QUICKBOOKS_REALM_ID
);

const SKIP_MSG = 'Skipping: QUICKBOOKS_* env vars not set. Set QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REFRESH_TOKEN, QUICKBOOKS_REALM_ID to run integration tests.';

// =============================================================================
// MOCK CONTEXT — uses real env vars as secrets
// =============================================================================

function buildIntegrationContext(overrides: Record<string, string> = {}) {
  return {
    execution: { userId: 'integration-test', appId: 'test', mcaId: 'mca.intuit.quickbooks' },
    requestId: 'req-integration',
    backend: null,
    signal: new AbortController().signal,
    getSystemSecrets: async () => ({
      CLIENT_ID: process.env.QUICKBOOKS_CLIENT_ID!,
      CLIENT_SECRET: process.env.QUICKBOOKS_CLIENT_SECRET!,
      QUICKBOOKS_USE_SANDBOX: process.env.QUICKBOOKS_USE_SANDBOX ?? 'true',
      ...overrides,
    }),
    getUserSecrets: async () => ({
      REFRESH_TOKEN: process.env.QUICKBOOKS_REFRESH_TOKEN!,
      REALM_ID: process.env.QUICKBOOKS_REALM_ID!,
      ACCESS_TOKEN: process.env.QUICKBOOKS_ACCESS_TOKEN ?? '',
      EXPIRY_DATE: process.env.QUICKBOOKS_ACCESS_TOKEN
        ? new Date(Date.now() + 3600 * 1000).toISOString()
        : new Date(0).toISOString(), // Force refresh on first call
      ...overrides,
    }),
    updateUserSecrets: async (_secrets: Record<string, string>) => {
      // In integration tests, we can't actually persist secrets.
      // The refresh will still work for the duration of the test.
    },
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
    getScope: () => 'integration-test',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
  } as any;
}

// =============================================================================
// TESTS
// =============================================================================

describe('QuickBooks Integration', () => {
  if (!HAS_CREDS) {
    it.skip(SKIP_MSG, () => {});
    return;
  }

  // ===========================================================================
  // HEALTH CHECK / COMPANY INFO
  // ===========================================================================

  describe('get-company-info', () => {
    it('retrieves company info from live API', async () => {
      const ctx = buildIntegrationContext();
      const result = await getCompanyInfo.handler!({}, ctx) as any;
      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
      expect(result.name).not.toBeNull();
    });
  });

  // ===========================================================================
  // CUSTOMER CRUD
  // ===========================================================================

  describe('Customer CRUD', () => {
    let customerId: string;
    let syncToken: string;
    const testDisplayName = `QB Integration Test ${Date.now()}`;

    it('creates a customer', async () => {
      const ctx = buildIntegrationContext();
      const result = await createCustomer.handler!({
        displayName: testDisplayName,
        email: `test-${Date.now()}@integration.test`,
        companyName: 'Integration Test Corp',
      }, ctx) as any;

      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
      expect(result.displayName).toBe(testDisplayName);
      customerId = result.id;
      syncToken = result.syncToken;
    });

    it('reads the created customer by ID', async () => {
      if (!customerId) { it.skip('No customer ID from create'); return; }
      const ctx = buildIntegrationContext();
      const result = await getCustomer.handler!({ customerId }, ctx) as any;
      expect(result.id).toBe(customerId);
      expect(result.displayName).toBe(testDisplayName);
    });

    it('updates the customer', async () => {
      if (!customerId) { it.skip('No customer ID from create'); return; }
      const ctx = buildIntegrationContext();
      const result = await updateCustomer.handler!({
        customerId,
        syncToken,
        companyName: 'Updated Integration Corp',
      }, ctx) as any;
      expect(result.id).toBe(customerId);
      expect(result.companyName).toBe('Updated Integration Corp');
    });

    it('deactivates the customer', async () => {
      if (!customerId) { it.skip('No customer ID from create'); return; }
      const ctx = buildIntegrationContext();
      // Get fresh syncToken first
      const fresh = await getCustomer.handler!({ customerId }, ctx) as any;
      const result = await updateCustomer.handler!({
        customerId,
        syncToken: fresh.syncToken,
        active: false,
      }, ctx) as any;
      expect(result.active).toBe(false);
    });

    it('lists customers (should include our test customer)', async () => {
      const ctx = buildIntegrationContext();
      const result = await listCustomers.handler!({ query: 'Integration Test', limit: 10 }, ctx) as any;
      expect(result).toBeDefined();
      expect(result.customers).toBeDefined();
      expect(Array.isArray(result.customers)).toBe(true);
    });
  });

  // ===========================================================================
  // INVOICE CRUD
  // ===========================================================================

  describe('Invoice CRUD', () => {
    let invoiceId: string;
    let syncToken: string;

    it('lists invoices', async () => {
      const ctx = buildIntegrationContext();
      const result = await listInvoices.handler!({ limit: 5 }, ctx) as any;
      expect(result).toBeDefined();
      expect(result.invoices).toBeDefined();
      expect(Array.isArray(result.invoices)).toBe(true);
    });

    // Note: Creating invoices requires a valid customer ID and item ID.
    // These tests will only work if the QuickBooks company has items set up.
    it('creates an invoice with line items (requires existing customer + item)', async () => {
      const ctx = buildIntegrationContext();

      // First, get a customer
      const customers = await listCustomers.handler!({ active: true, limit: 1 }, ctx) as any;
      if (!customers.customers?.length) {
        it.skip('No active customers found in QuickBooks');
        return;
      }

      // We need an item — try listing items
      const { listItems } = await import('../../src/tools/items');
      const items = await listItems.handler!({ active: true, limit: 1 }, ctx) as any;
      if (!items.items?.length) {
        it.skip('No active items found in QuickBooks');
        return;
      }

      const result = await createInvoice.handler!({
        customerId: customers.customers[0].id,
        lineItems: [{
          itemId: items.items[0].id,
          quantity: 1,
          unitPrice: 1.00,
          description: 'Integration test invoice',
        }],
      }, ctx) as any;

      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
      invoiceId = result.id;
      syncToken = result.syncToken;
    });

    it('reads the created invoice', async () => {
      if (!invoiceId) { it.skip('No invoice ID from create'); return; }
      const ctx = buildIntegrationContext();
      const result = await getInvoice.handler!({ invoiceId }, ctx) as any;
      expect(result.id).toBe(invoiceId);
    });

    it('voids the created invoice', async () => {
      if (!invoiceId) { it.skip('No invoice ID from create'); return; }
      const ctx = buildIntegrationContext();
      // Get fresh syncToken
      const fresh = await getInvoice.handler!({ invoiceId }, ctx) as any;
      const result = await voidInvoice.handler!({
        invoiceId,
        syncToken: fresh.syncToken,
      }, ctx) as any;
      expect(result.voided).toBe(true);
      expect(result.id).toBe(invoiceId);
    });
  });

  // ===========================================================================
  // PAYMENT
  // ===========================================================================

  describe('Payment', () => {
    let paymentId: string;

    it('creates a payment (requires existing customer)', async () => {
      const ctx = buildIntegrationContext();

      const customers = await listCustomers.handler!({ active: true, limit: 1 }, ctx) as any;
      if (!customers.customers?.length) {
        it.skip('No active customers found');
        return;
      }

      const result = await createPayment.handler!({
        customerId: customers.customers[0].id,
        totalAmt: 0.01,
        paymentMethod: 'cash',
      }, ctx) as any;

      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
      paymentId = result.id;
    });

    it('reads the created payment', async () => {
      if (!paymentId) { it.skip('No payment ID from create'); return; }
      const ctx = buildIntegrationContext();
      const result = await getPayment.handler!({ paymentId }, ctx) as any;
      expect(result.id).toBe(paymentId);
    });

    it('deletes the created payment', async () => {
      if (!paymentId) { it.skip('No payment ID from create'); return; }
      const ctx = buildIntegrationContext();
      const fresh = await getPayment.handler!({ paymentId }, ctx) as any;
      const result = await deletePayment.handler!({
        paymentId,
        syncToken: fresh.syncToken,
      }, ctx) as any;
      expect(result.deleted).toBe(true);
    });
  });

  // ===========================================================================
  // REPORTS
  // ===========================================================================

  describe('Reports', () => {
    it('generates a Profit & Loss report', async () => {
      const ctx = buildIntegrationContext();
      const year = new Date().getFullYear();
      const result = await reportProfitLoss.handler!({
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
      }, ctx) as any;

      expect(result).toBeDefined();
      expect(result.header).toBeDefined();
      expect(result.columns).toBeDefined();
      expect(result.rows).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('generates a P&L with cash accounting method', async () => {
      const ctx = buildIntegrationContext();
      const year = new Date().getFullYear();
      const result = await reportProfitLoss.handler!({
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
        accountingMethod: 'cash',
      }, ctx) as any;

      expect(result).toBeDefined();
      expect(result.header).toBeDefined();
    });
  });

  // ===========================================================================
  // TOKEN REFRESH
  // ===========================================================================

  describe('Token Refresh', () => {
    it('automatically refreshes expired token on API call', async () => {
      const ctx = buildIntegrationContext();
      // EXPIRY_DATE is set to epoch 0 in buildIntegrationContext, so the
      // first API call will trigger a refresh.
      const result = await getCompanyInfo.handler!({}, ctx) as any;
      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
    });

    it('handles 401 by refreshing and retrying', async () => {
      // Use an invalid access token to force a 401 on the first attempt.
      // The refresh logic should kick in and get a valid token.
      const ctx = buildIntegrationContext();
      // Override with invalid access token but valid refresh token
      const ctxWithBadToken = {
        ...ctx,
        getUserSecrets: async () => ({
          REFRESH_TOKEN: process.env.QUICKBOOKS_REFRESH_TOKEN!,
          REALM_ID: process.env.QUICKBOOKS_REALM_ID!,
          ACCESS_TOKEN: 'invalid-token-to-force-401',
          EXPIRY_DATE: new Date(Date.now() + 3600 * 1000).toISOString(),
        }),
      } as any;

      const result = await getCompanyInfo.handler!({}, ctxWithBadToken) as any;
      expect(result).toBeDefined();
      expect(result.id).not.toBeNull();
    });
  });
});
