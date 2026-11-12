#!/usr/bin/env bun

/**
 * QuickBooks Online MCA v1.0.0
 *
 * QuickBooks Online Accounting API integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Features:
 * - OAuth 2.0 with automatic token refresh
 * - Health check (verifies credentials against the live API)
 * - Company info retrieval
 * - Customer & Vendor CRUD
 * - Invoice CRUD + void + send
 * - Payment CRUD
 * - Bill CRUD
 * - Account & Item management
 * - 9 financial reports (P&L, Balance Sheet, Cash Flow, Aged AR/AP, Trial Balance, GL, Customer Balance, Sales by Customer)
 *
 * Base URLs:
 * - Production: https://quickbooks.api.intuit.com/v3/company/{realmId}/
 * - Sandbox:     https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/
 *   (activated by system secret QUICKBOOKS_USE_SANDBOX=true)
 *
 * Token endpoint: https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer
 * Auth header for token requests: Basic base64(client_id:client_secret)
 */

import { McaServer } from '@teros/mca-sdk';

import {
  healthCheck,
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
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.intuit.quickbooks',
  name: 'QuickBooks Online',
  version: '1.0.0',
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

// --- Health check ---
server.tool('-health-check', healthCheck as any);

// --- Company ---
server.tool('get-company-info', getCompanyInfo as any);

// --- Customers ---
server.tool('list-customers', listCustomers as any);
server.tool('get-customer', getCustomer as any);
server.tool('create-customer', createCustomer as any);
server.tool('update-customer', updateCustomer as any);

// --- Vendors ---
server.tool('list-vendors', listVendors as any);
server.tool('get-vendor', getVendor as any);
server.tool('create-vendor', createVendor as any);
server.tool('update-vendor', updateVendor as any);

// --- Invoices ---
server.tool('list-invoices', listInvoices as any);
server.tool('get-invoice', getInvoice as any);
server.tool('create-invoice', createInvoice as any);
server.tool('update-invoice', updateInvoice as any);
server.tool('void-invoice', voidInvoice as any);
server.tool('send-invoice', sendInvoice as any);

// --- Payments ---
server.tool('list-payments', listPayments as any);
server.tool('get-payment', getPayment as any);
server.tool('create-payment', createPayment as any);
server.tool('delete-payment', deletePayment as any);

// --- Bills ---
server.tool('list-bills', listBills as any);
server.tool('get-bill', getBill as any);
server.tool('create-bill', createBill as any);
server.tool('update-bill', updateBill as any);
server.tool('delete-bill', deleteBill as any);

// --- Accounts ---
server.tool('list-accounts', listAccounts as any);
server.tool('get-account', getAccount as any);
server.tool('create-account', createAccount as any);

// --- Items ---
server.tool('list-items', listItems as any);
server.tool('get-item', getItem as any);
server.tool('create-item', createItem as any);

// --- Reports ---
server.tool('report-profit-loss', reportProfitLoss as any);
server.tool('report-balance-sheet', reportBalanceSheet as any);
server.tool('report-cash-flow', reportCashFlow as any);
server.tool('report-aged-receivables', reportAgedReceivables as any);
server.tool('report-aged-payables', reportAgedPayables as any);
server.tool('report-trial-balance', reportTrialBalance as any);
server.tool('report-general-ledger', reportGeneralLedger as any);
server.tool('report-customer-balance', reportCustomerBalance as any);
server.tool('report-sales-by-customer', reportSalesByCustomer as any);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('📗 QuickBooks Online MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start QuickBooks Online MCA:', error);
    process.exit(1);
  });
