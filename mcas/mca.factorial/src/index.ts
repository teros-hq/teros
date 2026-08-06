#!/usr/bin/env bun

/**
 * Factorial MCA v1.0
 *
 * Factorial HR integration using McaServer with HTTP transport.
 * Authenticates via OAuth2 — users connect their Factorial account.
 *
 * Tools:
 * - Health:    -health-check
 * - Employees: list-employees, get-employee
 * - Teams:     list-teams, list-team-memberships
 * - Time Off:  list-leaves, get-leave, create-leave, list-leave-types
 * - Attendance: list-shifts, list-worked-times, list-overtime-requests, approve-overtime, reject-overtime
 * - Documents:  list-documents, get-document
 * - Contracts:  list-contract-versions, list-compensations
 * - Company:  list-legal-entities, list-locations
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { factorialRequest } from './lib';
import {
  approveOvertime,
  createLeave,
  getDocument,
  getEmployee,
  getLeave,
  listCompensations,
  listContractVersions,
  listDocuments,
  listEmployees,
  listLeaveTypes,
  listLeaves,
  listLegalEntities,
  listLocations,
  listOvertimeRequests,
  listShifts,
  listTeamMemberships,
  listTeams,
  listWorkedTimes,
  rejectOvertime,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.factorial',
  name: 'Factorial',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const token = userSecrets.ACCESS_TOKEN as string | undefined;

      if (!token) {
        builder.addIssue('AUTH_REQUIRED', 'Factorial account not connected', {
          type: 'user_action',
          description: 'Connect your Factorial account via OAuth to use this integration.',
        });
        return builder.build();
      }

      // Validate token with a real API call
      await factorialRequest(context, '/employees/employees?limit=1');
    } catch (error) {
      builder.addIssue(
        'CONNECTION_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to Factorial',
        {
          type: 'user_action',
          description: 'Reconnect your Factorial account via OAuth.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// EMPLOYEES
// =============================================================================

server.tool('list-employees', listEmployees);
server.tool('get-employee', getEmployee);

// =============================================================================
// TEAMS
// =============================================================================

server.tool('list-teams', listTeams);
server.tool('list-team-memberships', listTeamMemberships);

// =============================================================================
// TIME OFF
// =============================================================================

server.tool('list-leaves', listLeaves);
server.tool('get-leave', getLeave);
server.tool('create-leave', createLeave);
server.tool('list-leave-types', listLeaveTypes);

// =============================================================================
// ATTENDANCE
// =============================================================================

server.tool('list-shifts', listShifts);
server.tool('list-worked-times', listWorkedTimes);
server.tool('list-overtime-requests', listOvertimeRequests);
server.tool('approve-overtime', approveOvertime);
server.tool('reject-overtime', rejectOvertime);

// =============================================================================
// DOCUMENTS
// =============================================================================

server.tool('list-documents', listDocuments);
server.tool('get-document', getDocument);

// =============================================================================
// CONTRACTS & PAYROLL
// =============================================================================

server.tool('list-contract-versions', listContractVersions);
server.tool('list-compensations', listCompensations);

// =============================================================================
// COMPANY
// =============================================================================

server.tool('list-legal-entities', listLegalEntities);
server.tool('list-locations', listLocations);

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[Factorial MCA] Fatal error:', error);
  process.exit(1);
});
