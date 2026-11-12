#!/usr/bin/env bun

/**
 * Holded MCA v2.0.0 (Full API v2 Scope)
 *
 * Holded integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Modules:
 * - Health check (API key validation)
 * - Contacts (list, get, create, update, delete, search)
 * - Contact Groups (list, get, create, update, delete)
 * - Tags (list, create, delete)
 * - Invoices (list, get, create, update, delete, cancel, approve, send, find, PDF)
 * - Sales Documents (estimates, proformas, credit notes, recurring invoices, receipts, services, channels, numbering)
 * - Products (list, get, create, update, delete)
 * - Inventory (warehouses, price lists)
 * - Accounting (accounts, ledger, expenses, payments, purchases, taxes)
 * - Treasury (banking accounts, movements, payment methods, remittances)
 * - CRM (funnels, leads)
 * - Projects (projects, tasks, time entries)
 * - Team & HR (employees, time entries, payslips, time-off)
 * - Calendar (events)
 * - Inbox (documents)
 * - Developers (API usage, webhooks)
 */

import { McaServer } from '@teros/mca-sdk';
import {
  // Health check
  healthCheck,
  // Contacts
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
  // Contact Groups
  listContactGroups,
  getContactGroup,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  // Tags
  listTags,
  createTag,
  deleteTag,
  // Invoices
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  cancelInvoice,
  approveInvoice,
  sendInvoice,
  findInvoices,
  getInvoicePdf,
  // Sales Documents
  listEstimates,
  getEstimate,
  createEstimate,
  listProformas,
  getProforma,
  listCreditNotes,
  getCreditNote,
  listRecurringInvoices,
  getRecurringInvoice,
  listSalesReceipts,
  listServices,
  listSalesChannels,
  listNumberingSeries,
  // Products
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  // Inventory
  listWarehouses,
  getWarehouse,
  listPriceLists,
  getPriceList,
  // Accounting
  listAccountingAccounts,
  listLedgerEntries,
  listExpensesAccounts,
  getExpensesAccount,
  listPayments,
  getPayment,
  createPayment,
  updatePayment,
  deletePayment,
  listTaxes,
  // Purchases
  listPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  deletePurchase,
  attachPurchaseFile,
  listPurchaseAttachments,
  // Treasury
  listBankingAccounts,
  getBankingAccount,
  listBankingMovements,
  listPaymentMethods,
  getPaymentMethod,
  listRemittances,
  getRemittance,
  // CRM
  listFunnels,
  getFunnel,
  listLeads,
  getLead,
  createLead,
  updateLead,
  updateLeadStage,
  // Projects
  listProjects,
  getProject,
  getProjectSummary,
  listTasks,
  getTask,
  createTask,
  listProjectTimeEntries,
  listAllTimeEntries,
  // Team & HR
  listEmployees,
  getEmployee,
  listEmployeeTimeEntries,
  listAllEmployeeTimeEntries,
  listPayslips,
  getPayslip,
  listTimeOffRequests,
  getTimeOffRequest,
  // Calendar
  listEvents,
  getEvent,
  createEvent,
  // Inbox
  listInboxDocuments,
  getInboxDocument,
  // Developers
  getApiUsage,
  getApiUsageByType,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listWebhookEvents,
} from './tools/index.js';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.holded',
  name: 'Holded',
  version: '2.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', healthCheck);

// =============================================================================
// REGISTER TOOLS — Contacts
// =============================================================================

server.tool('list-contacts', listContacts);
server.tool('get-contact', getContact);
server.tool('create-contact', createContact);
server.tool('update-contact', updateContact);
server.tool('delete-contact', deleteContact);
server.tool('search-contacts', searchContacts);

// =============================================================================
// REGISTER TOOLS — Contact Groups
// =============================================================================

server.tool('list-contact-groups', listContactGroups);
server.tool('get-contact-group', getContactGroup);
server.tool('create-contact-group', createContactGroup);
server.tool('update-contact-group', updateContactGroup);
server.tool('delete-contact-group', deleteContactGroup);

// =============================================================================
// REGISTER TOOLS — Tags
// =============================================================================

server.tool('list-tags', listTags);
server.tool('create-tag', createTag);
server.tool('delete-tag', deleteTag);

// =============================================================================
// REGISTER TOOLS — Invoices
// =============================================================================

server.tool('list-invoices', listInvoices);
server.tool('get-invoice', getInvoice);
server.tool('create-invoice', createInvoice);
server.tool('update-invoice', updateInvoice);
server.tool('delete-invoice', deleteInvoice);
server.tool('cancel-invoice', cancelInvoice);
server.tool('approve-invoice', approveInvoice);
server.tool('send-invoice', sendInvoice);
server.tool('find-invoices', findInvoices);
server.tool('get-invoice-pdf', getInvoicePdf);

// =============================================================================
// REGISTER TOOLS — Sales Documents
// =============================================================================

server.tool('list-estimates', listEstimates);
server.tool('get-estimate', getEstimate);
server.tool('create-estimate', createEstimate);
server.tool('list-proformas', listProformas);
server.tool('get-proforma', getProforma);
server.tool('list-credit-notes', listCreditNotes);
server.tool('get-credit-note', getCreditNote);
server.tool('list-recurring-invoices', listRecurringInvoices);
server.tool('get-recurring-invoice', getRecurringInvoice);
server.tool('list-sales-receipts', listSalesReceipts);
server.tool('list-services', listServices);
server.tool('list-sales-channels', listSalesChannels);
server.tool('list-numbering-series', listNumberingSeries);

// =============================================================================
// REGISTER TOOLS — Products
// =============================================================================

server.tool('list-products', listProducts);
server.tool('get-product', getProduct);
server.tool('create-product', createProduct);
server.tool('update-product', updateProduct);
server.tool('delete-product', deleteProduct);

// =============================================================================
// REGISTER TOOLS — Inventory
// =============================================================================

server.tool('list-warehouses', listWarehouses);
server.tool('get-warehouse', getWarehouse);
server.tool('list-price-lists', listPriceLists);
server.tool('get-price-list', getPriceList);

// =============================================================================
// REGISTER TOOLS — Accounting
// =============================================================================

server.tool('list-accounting-accounts', listAccountingAccounts);
server.tool('list-ledger-entries', listLedgerEntries);
server.tool('list-expenses-accounts', listExpensesAccounts);
server.tool('get-expenses-account', getExpensesAccount);
server.tool('list-payments', listPayments);
server.tool('get-payment', getPayment);
server.tool('create-payment', createPayment);
server.tool('update-payment', updatePayment);
server.tool('delete-payment', deletePayment);
server.tool('list-taxes', listTaxes);

// =============================================================================
// REGISTER TOOLS — Purchases
// =============================================================================

server.tool('list-purchases', listPurchases);
server.tool('get-purchase', getPurchase);
server.tool('create-purchase', createPurchase);
server.tool('update-purchase', updatePurchase);
server.tool('delete-purchase', deletePurchase);
server.tool('attach-purchase-file', attachPurchaseFile);
server.tool('list-purchase-attachments', listPurchaseAttachments);

// =============================================================================
// REGISTER TOOLS — Treasury
// =============================================================================

server.tool('list-banking-accounts', listBankingAccounts);
server.tool('get-banking-account', getBankingAccount);
server.tool('list-banking-movements', listBankingMovements);
server.tool('list-payment-methods', listPaymentMethods);
server.tool('get-payment-method', getPaymentMethod);
server.tool('list-remittances', listRemittances);
server.tool('get-remittance', getRemittance);

// =============================================================================
// REGISTER TOOLS — CRM
// =============================================================================

server.tool('list-funnels', listFunnels);
server.tool('get-funnel', getFunnel);
server.tool('list-leads', listLeads);
server.tool('get-lead', getLead);
server.tool('create-lead', createLead);
server.tool('update-lead', updateLead);
server.tool('update-lead-stage', updateLeadStage);

// =============================================================================
// REGISTER TOOLS — Projects
// =============================================================================

server.tool('list-projects', listProjects);
server.tool('get-project', getProject);
server.tool('get-project-summary', getProjectSummary);
server.tool('list-tasks', listTasks);
server.tool('get-task', getTask);
server.tool('create-task', createTask);
server.tool('list-project-time-entries', listProjectTimeEntries);
server.tool('list-all-time-entries', listAllTimeEntries);

// =============================================================================
// REGISTER TOOLS — Team & HR
// =============================================================================

server.tool('list-employees', listEmployees);
server.tool('get-employee', getEmployee);
server.tool('list-employee-time-entries', listEmployeeTimeEntries);
server.tool('list-all-employee-time-entries', listAllEmployeeTimeEntries);
server.tool('list-payslips', listPayslips);
server.tool('get-payslip', getPayslip);
server.tool('list-time-off-requests', listTimeOffRequests);
server.tool('get-time-off-request', getTimeOffRequest);

// =============================================================================
// REGISTER TOOLS — Calendar
// =============================================================================

server.tool('list-events', listEvents);
server.tool('get-event', getEvent);
server.tool('create-event', createEvent);

// =============================================================================
// REGISTER TOOLS — Inbox
// =============================================================================

server.tool('list-inbox-documents', listInboxDocuments);
server.tool('get-inbox-document', getInboxDocument);

// =============================================================================
// REGISTER TOOLS — Developers
// =============================================================================

server.tool('get-api-usage', getApiUsage);
server.tool('get-api-usage-by-type', getApiUsageByType);
server.tool('list-webhooks', listWebhooks);
server.tool('get-webhook', getWebhook);
server.tool('create-webhook', createWebhook);
server.tool('update-webhook', updateWebhook);
server.tool('delete-webhook', deleteWebhook);
server.tool('list-webhook-events', listWebhookEvents);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔷 Holded MCA server running (v2.0.0 — full API v2 scope)');
  })
  .catch((error) => {
    console.error('Failed to start Holded MCA:', error);
    process.exit(1);
  });
