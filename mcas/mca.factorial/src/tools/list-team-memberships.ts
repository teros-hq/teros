import { factorialRequest, buildQueryString } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listTeamMemberships: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all team memberships (employee-team associations).',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'number', description: 'Filter by team ID' },
      employeeId: { type: 'number', description: 'Filter by employee ID' },
    },
  },
  handler: async (args, context) => {
    const qs = buildQueryString({
      team_id: args.teamId,
      employee_id: args.employeeId,
    });
    return factorialRequest(context, `/teams/memberships${qs}`);
  },
};
