#!/usr/bin/env npx tsx

/**
 * Linear MCA v1.0.0
 *
 * Linear issue tracking using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { LinearClient } from '@linear/sdk';
import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

interface LinearSecrets {
  API_KEY?: string;
}

// =============================================================================
// LINEAR CLIENT FACTORY
// =============================================================================

/**
 * Creates an authenticated Linear client from secrets
 */
function createLinearClient(secrets: LinearSecrets): LinearClient {
  const apiKey = secrets.API_KEY;

  if (!apiKey) {
    throw new Error('Linear API key not configured. Please configure it in app settings.');
  }

  return new LinearClient({ apiKey });
}

// =============================================================================
// PRIORITY HELPERS
// =============================================================================

const PRIORITY_TO_NUMBER: Record<string, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const NUMBER_TO_PRIORITY: Record<number, string> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.linear',
  name: 'Linear',
  version: '1.0.0',
});

// -----------------------------------------------------------------------------
// Health Check Tool
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Linear API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const secrets = userSecrets as LinearSecrets;

      // Check user secrets
      if (!secrets.API_KEY) {
        builder.addIssue('USER_CONFIG_MISSING', 'Linear API key not configured', {
          type: 'user_action',
          description: 'Configure your Linear API key in app settings',
        });
      } else {
        // Try to validate API key
        try {
          const client = createLinearClient(secrets);
          await client.viewer;
        } catch (apiError: any) {
          if (
            apiError.message?.includes('401') ||
            apiError.message?.includes('403') ||
            apiError.message?.includes('Unauthorized')
          ) {
            builder.addIssue('AUTH_INVALID', 'Linear API key is invalid', {
              type: 'user_action',
              description: 'The configured API key is invalid. Please update it.',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Linear API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Linear API temporarily unavailable',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// List Issues
// -----------------------------------------------------------------------------

server.tool('linear-list-issues', {
  description: 'List issues with optional filtering',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team ID' },
      status: { type: 'string', description: "Filter by status (e.g., 'Backlog', 'In Progress')" },
      assigneeId: { type: 'string', description: 'Filter by assignee ID' },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'Filter by priority',
      },
      limit: { type: 'number', description: 'Number of issues to return', default: 50 },
    },
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const teamId = args.teamId as string | undefined;
    const status = args.status as string | undefined;
    const assigneeId = args.assigneeId as string | undefined;
    const priority = args.priority as string | undefined;
    const limit = (args.limit as number) || 50;

    const filter: any = {};
    if (teamId) filter.team = { id: { eq: teamId } };
    if (assigneeId) filter.assignee = { id: { eq: assigneeId } };
    if (status) {
      const statusMap: Record<string, string> = {
        backlog: 'backlog',
        unstarted: 'unstarted',
        started: 'started',
        completed: 'completed',
        canceled: 'canceled',
      };
      filter.state = { type: { eq: statusMap[status.toLowerCase()] || status } };
    }
    if (priority) {
      filter.priority = { eq: PRIORITY_TO_NUMBER[priority] };
    }

    const issues = await client.issues({
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      first: limit,
    });

    const formattedIssues = await Promise.all(
      issues.nodes.map(async (issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: (await issue.state)?.name,
        priority: NUMBER_TO_PRIORITY[issue.priority] || issue.priority,
        assignee: (await issue.assignee)?.name,
        url: issue.url,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
      })),
    );

    return { count: formattedIssues.length, issues: formattedIssues };
  },
});

// -----------------------------------------------------------------------------
// Get Issue
// -----------------------------------------------------------------------------

server.tool('linear-get-issue', {
  description: 'Get detailed issue information',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID to retrieve' },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const issue = await client.issue(issueId);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: (await issue.state)?.name,
      priority: NUMBER_TO_PRIORITY[issue.priority] || issue.priority,
      assignee: (await issue.assignee)?.name,
      team: (await issue.team)?.name,
      labels: (await issue.labels())?.nodes.map((l) => l.name),
      url: issue.url,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    };
  },
});

// -----------------------------------------------------------------------------
// Create Issue
// -----------------------------------------------------------------------------

server.tool('linear-create-issue', {
  description: 'Create a new issue',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Issue title' },
      teamId: { type: 'string', description: 'Team ID (required)' },
      description: { type: 'string', description: 'Issue description' },
      assigneeId: { type: 'string', description: 'Assignee ID' },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'Issue priority',
        default: 'medium',
      },
      projectId: { type: 'string', description: 'Project ID' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add' },
    },
    required: ['title', 'teamId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issuePayload: any = {
      title: args.title as string,
      teamId: args.teamId as string,
    };

    if (args.description) issuePayload.description = args.description;
    if (args.assigneeId) issuePayload.assigneeId = args.assigneeId;
    if (args.projectId) issuePayload.projectId = args.projectId;
    if (args.labels) issuePayload.labelIds = args.labels;
    if (args.priority) {
      issuePayload.priority = PRIORITY_TO_NUMBER[args.priority as string];
    }

    const issueResponse = await client.createIssue(issuePayload);
    const issue = await issueResponse.issue;

    return {
      success: true,
      id: issue?.id,
      identifier: issue?.identifier,
      title: issue?.title,
      url: issue?.url,
    };
  },
});

// -----------------------------------------------------------------------------
// Update Issue
// -----------------------------------------------------------------------------

server.tool('linear-update-issue', {
  description: 'Update an existing issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID to update' },
      title: { type: 'string', description: 'Updated issue title' },
      description: { type: 'string', description: 'Updated issue description' },
      statusId: { type: 'string', description: 'Updated status ID' },
      assigneeId: { type: 'string', description: 'Updated assignee ID' },
      priority: {
        type: 'string',
        enum: ['urgent', 'high', 'medium', 'low'],
        description: 'Updated priority',
      },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const updatePayload: any = {};

    if (args.title) updatePayload.title = args.title;
    if (args.description !== undefined) updatePayload.description = args.description;
    if (args.assigneeId) updatePayload.assigneeId = args.assigneeId;
    if (args.statusId) updatePayload.stateId = args.statusId;
    if (args.priority) {
      updatePayload.priority = PRIORITY_TO_NUMBER[args.priority as string];
    }

    await client.updateIssue(issueId, updatePayload);

    return { success: true, issueId, message: `Issue ${issueId} updated successfully` };
  },
});

// -----------------------------------------------------------------------------
// List Teams
// -----------------------------------------------------------------------------

server.tool('linear-list-teams', {
  description: 'List all teams',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const teams = await client.teams();
    const formattedTeams = teams.nodes.map((team) => ({
      id: team.id,
      name: team.name,
      key: team.key,
    }));

    return { count: formattedTeams.length, teams: formattedTeams };
  },
});

// -----------------------------------------------------------------------------
// List Users
// -----------------------------------------------------------------------------

server.tool('linear-list-users', {
  description: 'List all users in workspace',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team ID' },
    },
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const users = await client.users();
    const formattedUsers = users.nodes.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      active: user.active,
    }));

    return { count: formattedUsers.length, users: formattedUsers };
  },
});

// -----------------------------------------------------------------------------
// Add Comment
// -----------------------------------------------------------------------------

server.tool('linear-add-comment', {
  description: 'Add comment to an issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID to comment on' },
      body: { type: 'string', description: 'Comment content' },
    },
    required: ['issueId', 'body'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const body = args.body as string;

    const issue = await client.issue(issueId);
    await client.createComment({
      issueId: issue.id,
      body,
    });

    return { success: true, issueId, message: `Comment added to issue ${issueId}` };
  },
});

// -----------------------------------------------------------------------------
// Delete Issue
// -----------------------------------------------------------------------------

server.tool('linear-delete-issue', {
  description: 'Permanently delete an issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID to delete' },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const result = await client.deleteIssue(issueId);

    return {
      success: result.success,
      issueId,
      message: result.success
        ? `Issue ${issueId} deleted successfully`
        : `Failed to delete issue ${issueId}`,
    };
  },
});

// -----------------------------------------------------------------------------
// Archive Issue
// -----------------------------------------------------------------------------

server.tool('linear-archive-issue', {
  description: 'Archive an issue (soft delete)',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID to archive' },
    },
    required: ['issueId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    await client.archiveIssue(issueId);

    return { success: true, issueId, message: `Issue ${issueId} archived successfully` };
  },
});

// -----------------------------------------------------------------------------
// List Projects
// -----------------------------------------------------------------------------

server.tool('linear-list-projects', {
  description: 'List all projects',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team ID' },
      limit: { type: 'number', description: 'Number of projects to return', default: 50 },
    },
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const teamId = args.teamId as string | undefined;
    const limit = (args.limit as number) || 50;

    const filter: any = {};
    if (teamId) {
      filter.accessibleTeams = { some: { id: { eq: teamId } } };
    }

    const projects = await client.projects({
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      first: limit,
    });

    const formattedProjects = await Promise.all(
      projects.nodes.map(async (project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        state: project.state,
        url: project.url,
        createdAt: project.createdAt,
      })),
    );

    return { count: formattedProjects.length, projects: formattedProjects };
  },
});

// -----------------------------------------------------------------------------
// Create Project
// -----------------------------------------------------------------------------

server.tool('linear-create-project', {
  description: 'Create a new project',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name' },
      teamIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Team IDs that own this project',
      },
      description: { type: 'string', description: 'Project description' },
    },
    required: ['name', 'teamIds'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const projectResponse = await client.createProject({
      name: args.name as string,
      teamIds: args.teamIds as string[],
      description: args.description as string | undefined,
    });
    const project = await projectResponse.project;

    return {
      success: true,
      id: project?.id,
      name: project?.name,
      url: project?.url,
    };
  },
});

// -----------------------------------------------------------------------------
// List Labels
// -----------------------------------------------------------------------------

server.tool('linear-list-labels', {
  description: 'List all labels',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Filter by team ID' },
    },
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const teamId = args.teamId as string | undefined;

    let labels;
    if (teamId) {
      const team = await client.team(teamId);
      labels = await team.labels();
    } else {
      labels = await client.issueLabels();
    }

    const formattedLabels = labels.nodes.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description,
    }));

    return { count: formattedLabels.length, labels: formattedLabels };
  },
});

// -----------------------------------------------------------------------------
// Create Label
// -----------------------------------------------------------------------------

server.tool('linear-create-label', {
  description: 'Create a new label',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Label name' },
      teamId: { type: 'string', description: 'Team ID (required for team-specific labels)' },
      color: { type: 'string', description: "Label color in hex format (e.g., '#FF5733')" },
      description: { type: 'string', description: 'Label description' },
    },
    required: ['name', 'teamId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const labelPayload: any = {
      name: args.name as string,
      teamId: args.teamId as string,
    };

    if (args.color) labelPayload.color = args.color;
    if (args.description) labelPayload.description = args.description;

    const labelResponse = await client.createIssueLabel(labelPayload);
    const label = await labelResponse.issueLabel;

    return {
      success: true,
      id: label?.id,
      name: label?.name,
      color: label?.color,
    };
  },
});

// -----------------------------------------------------------------------------
// Update Label
// -----------------------------------------------------------------------------

server.tool('linear-update-label', {
  description: 'Update an existing label',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'Label ID to update' },
      name: { type: 'string', description: 'New label name' },
      color: { type: 'string', description: 'New label color in hex format' },
      description: { type: 'string', description: 'New label description' },
    },
    required: ['labelId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const labelId = args.labelId as string;
    const updatePayload: any = {};

    if (args.name) updatePayload.name = args.name;
    if (args.color) updatePayload.color = args.color;
    if (args.description !== undefined) updatePayload.description = args.description;

    await client.updateIssueLabel(labelId, updatePayload);

    return { success: true, labelId, message: `Label ${labelId} updated successfully` };
  },
});

// -----------------------------------------------------------------------------
// Delete Label
// -----------------------------------------------------------------------------

server.tool('linear-delete-label', {
  description: 'Delete a label',
  parameters: {
    type: 'object',
    properties: {
      labelId: { type: 'string', description: 'Label ID to delete' },
    },
    required: ['labelId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const labelId = args.labelId as string;
    const result = await client.deleteIssueLabel(labelId);

    return {
      success: result.success,
      labelId,
      message: result.success
        ? `Label ${labelId} deleted successfully`
        : `Failed to delete label ${labelId}`,
    };
  },
});

// -----------------------------------------------------------------------------
// Add Labels to Issue
// -----------------------------------------------------------------------------

server.tool('linear-add-labels-to-issue', {
  description: 'Add labels to an issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID' },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to add' },
    },
    required: ['issueId', 'labelIds'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const labelIds = args.labelIds as string[];

    const issue = await client.issue(issueId);
    const currentLabels = await issue.labels();
    const currentLabelIds = currentLabels.nodes.map((l) => l.id);
    const newLabelIds = [...new Set([...currentLabelIds, ...labelIds])];

    await client.updateIssue(issueId, { labelIds: newLabelIds });

    return {
      success: true,
      issueId,
      addedLabels: labelIds.length,
      message: `Labels added to issue ${issueId}`,
    };
  },
});

// -----------------------------------------------------------------------------
// Remove Labels from Issue
// -----------------------------------------------------------------------------

server.tool('linear-remove-labels-from-issue', {
  description: 'Remove labels from an issue',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue ID' },
      labelIds: { type: 'array', items: { type: 'string' }, description: 'Label IDs to remove' },
    },
    required: ['issueId', 'labelIds'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueId = args.issueId as string;
    const labelIds = args.labelIds as string[];

    const issue = await client.issue(issueId);
    const currentLabels = await issue.labels();
    const currentLabelIds = currentLabels.nodes.map((l) => l.id);
    const labelsToRemove = new Set(labelIds);
    const newLabelIds = currentLabelIds.filter((id) => !labelsToRemove.has(id));

    await client.updateIssue(issueId, { labelIds: newLabelIds });

    return {
      success: true,
      issueId,
      removedLabels: labelIds.length,
      message: `Labels removed from issue ${issueId}`,
    };
  },
});

// -----------------------------------------------------------------------------
// List Workflow States
// -----------------------------------------------------------------------------

server.tool('linear-list-workflow-states', {
  description: 'List workflow states for a team',
  parameters: {
    type: 'object',
    properties: {
      teamId: { type: 'string', description: 'Team ID' },
    },
    required: ['teamId'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const teamId = args.teamId as string;
    const team = await client.team(teamId);
    const states = await team.states();

    const formattedStates = states.nodes.map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      color: state.color,
      position: state.position,
    }));

    return { teamId, count: formattedStates.length, states: formattedStates };
  },
});

// -----------------------------------------------------------------------------
// Add Issues to Project
// -----------------------------------------------------------------------------

server.tool('linear-add-issues-to-project', {
  description: 'Add one or multiple issues to a project',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID to add issues to' },
      issueIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of issue IDs to add to the project',
      },
    },
    required: ['projectId', 'issueIds'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const projectId = args.projectId as string;
    const issueIds = args.issueIds as string[];

    const results: { issueId: string; success: boolean; identifier?: string; error?: string }[] =
      [];

    for (const issueId of issueIds) {
      try {
        await client.updateIssue(issueId, { projectId });
        const issue = await client.issue(issueId);
        results.push({ issueId, success: true, identifier: issue.identifier });
      } catch (error: any) {
        results.push({ issueId, success: false, error: error.message });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return {
      projectId,
      added: successCount,
      failed: failCount,
      results,
    };
  },
});

// -----------------------------------------------------------------------------
// Remove Issues from Project
// -----------------------------------------------------------------------------

server.tool('linear-remove-issues-from-project', {
  description: 'Remove one or multiple issues from their project',
  parameters: {
    type: 'object',
    properties: {
      issueIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of issue IDs to remove from their project',
      },
    },
    required: ['issueIds'],
  },
  handler: async (args, context) => {
    const secrets = (await context.getUserSecrets()) as LinearSecrets;
    const client = createLinearClient(secrets);

    const issueIds = args.issueIds as string[];

    const results: { issueId: string; success: boolean; identifier?: string; error?: string }[] =
      [];

    for (const issueId of issueIds) {
      try {
        await client.updateIssue(issueId, { projectId: null });
        const issue = await client.issue(issueId);
        results.push({ issueId, success: true, identifier: issue.identifier });
      } catch (error: any) {
        results.push({ issueId, success: false, error: error.message });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;

    return {
      removed: successCount,
      failed: failCount,
      results,
    };
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔷 Linear MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Linear MCA:', error);
    process.exit(1);
  });
