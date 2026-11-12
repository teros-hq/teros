// =============================================================================
// Barrel export for all Holded MCA tools
// =============================================================================

// Health check
export { healthCheck } from './health-check.js';

// Contacts
export {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  searchContacts,
} from './contacts.js';

// Contact Groups
export {
  listContactGroups,
  getContactGroup,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
} from './contact-groups.js';

// Tags
export { listTags, createTag, deleteTag } from './tags.js';

// Invoices
export {
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
} from './invoices.js';

// Sales Documents (estimates, proformas, credit notes, recurring invoices, etc.)
export {
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
  getSalesReceipt,
  listServices,
  getService,
  listSalesChannels,
  listNumberingSeries,
} from './sales-documents.js';

// Products
export {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from './products.js';

// Inventory (warehouses, price lists)
export {
  listWarehouses,
  getWarehouse,
  getWarehouseStock,
  listPriceLists,
  getPriceList,
} from './inventory.js';

// Accounting
export {
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
} from './accounting.js';

// Purchases (supplier invoices + attachments)
export {
  listPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  deletePurchase,
  attachPurchaseFile,
  listPurchaseAttachments,
} from './purchases.js';

// Treasury
export {
  listBankingAccounts,
  getBankingAccount,
  listBankingMovements,
  listPaymentMethods,
  getPaymentMethod,
  listRemittances,
  getRemittance,
} from './treasury.js';

// CRM
export {
  listFunnels,
  getFunnel,
  listLeads,
  getLead,
  createLead,
  updateLead,
  updateLeadStage,
  deleteLead,
} from './crm.js';

// Projects
export {
  listProjects,
  getProject,
  getProjectSummary,
  createProject,
  updateProject,
  deleteProject,
  listTasks,
  getTask,
  createTask,
  listProjectTimeEntries,
  listAllTimeEntries,
} from './projects.js';

// Team & HR
export {
  listEmployees,
  getEmployee,
  listEmployeeTimeEntries,
  listAllEmployeeTimeEntries,
  listPayslips,
  getPayslip,
  listTimeOffRequests,
  getTimeOffRequest,
} from './team-hr.js';

// Calendar
export { listEvents, getEvent, createEvent } from './calendar.js';

// Inbox
export { listInboxDocuments, getInboxDocument } from './inbox.js';

// Developers
export {
  getApiUsage,
  getApiUsageByType,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listWebhookEvents,
} from './developers.js';
