#!/usr/bin/env bun

/**
 * Odoo MCA v1.0.0
 *
 * Odoo ERP integration using McaServer with HTTP transport.
 * Authenticates via API key + base URL + database name.
 *
 * Tools:
 * - Health:       -health-check
 * - Generic CRUD: list-models, search-records, get-record, create-record,
 *                 update-record, delete-record, count-records, call-method
 * - CRM/Sales:    list-partners, get-partner, create-partner, update-partner,
 *                 list-products, list-sale-orders, get-sale-order, create-sale-order,
 *                 list-invoices
 * - Projects:     list-projects, list-tasks, create-project-task
 * - HR:           list-employees, list-leaves, create-leave,
 *                 list-timesheets, create-timesheet
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import type { ToolContext } from '@teros/mca-sdk';
import { authenticate } from './lib/odoo-client.js';
import {
  callMethod,
  countRecords,
  createLeave,
  createPartner,
  createProjectTask,
  createRecord,
  createSaleOrder,
  createTimesheet,
  deleteRecord,
  getPartner,
  getRecord,
  getSaleOrder,
  listEmployees,
  listInvoices,
  listLeaves,
  listModels,
  listPartners,
  listProducts,
  listProjects,
  listSaleOrders,
  listTasks,
  listTimesheets,
  searchRecords,
  updatePartner,
  updateRecord,
} from './tools/index.js';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.odoo',
  name: 'Odoo',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Odoo API key and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args: Record<string, unknown>, context: ToolContext) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      await authenticate(context);
    } catch (error) {
      builder.addIssue(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to Odoo',
        {
          type: 'user_action',
          description: 'Check your Odoo BASE_URL, DATABASE and API_KEY in the app settings.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// GENERIC MODEL OPERATIONS
// =============================================================================

server.tool('list-models', listModels);
server.tool('search-records', searchRecords);
server.tool('get-record', getRecord);
server.tool('create-record', createRecord);
server.tool('update-record', updateRecord);
server.tool('delete-record', deleteRecord);
server.tool('count-records', countRecords);
server.tool('call-method', callMethod);

// =============================================================================
// CRM & SALES
// =============================================================================

server.tool('list-partners', listPartners);
server.tool('get-partner', getPartner);
server.tool('create-partner', createPartner);
server.tool('update-partner', updatePartner);
server.tool('list-products', listProducts);
server.tool('list-sale-orders', listSaleOrders);
server.tool('get-sale-order', getSaleOrder);
server.tool('create-sale-order', createSaleOrder);
server.tool('list-invoices', listInvoices);

// =============================================================================
// PROJECTS
// =============================================================================

server.tool('list-projects', listProjects);
server.tool('list-tasks', listTasks);
server.tool('create-project-task', createProjectTask);

// =============================================================================
// HR
// =============================================================================

server.tool('list-employees', listEmployees);
server.tool('list-leaves', listLeaves);
server.tool('create-leave', createLeave);
server.tool('list-timesheets', listTimesheets);
server.tool('create-timesheet', createTimesheet);

// =============================================================================
// START
// =============================================================================

server.start().catch((error: unknown) => {
  console.error('[Odoo MCA] Fatal error:', error);
  process.exit(1);
});
