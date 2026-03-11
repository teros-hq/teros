#!/usr/bin/env npx tsx

/**
 * Railway MCA
 *
 * Deploy projects to Railway directly from Teros workspaces.
 * Supports automatic deployments, environment management, and database provisioning.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * User credentials (RAILWAY_TOKEN) are fetched on-demand from the backend.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { RailwayClient } from './railway-client.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get Railway token from user secrets
 */
function getToken(secrets: Record<string, string>): string | null {
  return secrets.RAILWAY_TOKEN || secrets.railwayToken || null;
}

/**
 * Create a Railway client from context
 */
async function createClient(
  context: any,
): Promise<RailwayClient> {
  const secrets = await context.getUserSecrets();
  const token = getToken(secrets);

  if (!token) {
    throw new Error(
      'Railway API token not configured. Please add your RAILWAY_TOKEN in the app settings. Get your token from https://railway.app/account/tokens',
    );
  }

  return new RailwayClient(token);
}

/**
 * Format project for display
 */
function formatProject(project: any): string {
  const envList =
    project.environments?.map((e: any) => e.name).join(', ') || 'none';
  const svcList =
    project.services?.map((s: any) => s.name).join(', ') || 'none';

  return `**${project.name}** (${project.id})
  - Environments: ${envList}
  - Services: ${svcList}
  - Created: ${project.createdAt}`;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.railway',
  name: 'Railway',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description:
    'Internal health check tool. Verifies Railway API token and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const secrets = await context.getUserSecrets();
      const token = getToken(secrets);

      if (!token) {
        builder.addIssue(
          'USER_CONFIG_MISSING',
          'Railway API token not configured',
          {
            type: 'user_action',
            description:
              'Add your RAILWAY_TOKEN in the app settings. Get your token from https://railway.app/account/tokens',
          },
        );
      } else {
        // Validate token
        const client = new RailwayClient(token);
        const isValid = await client.validateToken();

        if (!isValid) {
          builder.addIssue('USER_CONFIG_INVALID', 'Railway API token is invalid', {
            type: 'user_action',
            description:
              'Your Railway token is invalid or expired. Generate a new one at https://railway.app/account/tokens',
          });
        }
      }
    } catch (error) {
      builder.addIssue(
        'CONNECTIVITY_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to Railway',
        {
          type: 'retry',
          description: 'Check your internet connection and try again',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// USER & WORKSPACE TOOLS
// =============================================================================

server.tool('railway-get-user', {
  description: 'Get current Railway user info including available workspaces.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const user = await client.getMe();

    let result = `# Railway User\n\n`;
    result += `- **Name**: ${user.name}\n`;
    result += `- **Email**: ${user.email}\n`;
    result += `- **ID**: ${user.id}\n\n`;

    result += `## Workspaces\n`;
    if (user.workspaces.length === 0) {
      result += 'No workspaces found.\n';
    } else {
      for (const ws of user.workspaces) {
        result += `- **${ws.name}** (${ws.id})\n`;
      }
    }

    return result;
  },
});

server.tool('railway-list-workspaces', {
  description: 'List all Railway workspaces available to the current user.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const workspaces = await client.listWorkspaces();

    if (workspaces.length === 0) {
      return 'No workspaces found.';
    }

    const list = workspaces
      .map((ws) => `- **${ws.name}** (${ws.id})`)
      .join('\n');

    return `Available workspaces:\n\n${list}`;
  },
});

// =============================================================================
// PROJECT TOOLS
// =============================================================================

server.tool('railway-list-projects', {
  description: 'List all Railway projects in the connected account.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const projects = await client.listProjects();

    if (projects.length === 0) {
      return 'No projects found. Use railway-create-project to create one.';
    }

    const formatted = projects.map(formatProject).join('\n\n');
    return `Found ${projects.length} project(s):\n\n${formatted}`;
  },
});

server.tool('railway-get-project', {
  description:
    'Get detailed information about a Railway project including services and environments.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);
    const project = await client.getProject(projectId);

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    let result = `# Project: ${project.name}\n\n`;
    result += `- **ID**: ${project.id}\n`;
    result += `- **Description**: ${project.description || 'None'}\n`;
    result += `- **Created**: ${project.createdAt}\n\n`;

    result += `## Environments\n`;
    if (project.environments.length === 0) {
      result += 'No environments.\n';
    } else {
      for (const env of project.environments) {
        result += `- **${env.name}** (${env.id})\n`;
      }
    }

    result += `\n## Services\n`;
    if (project.services.length === 0) {
      result += 'No services.\n';
    } else {
      for (const svc of project.services) {
        result += `- **${svc.name}** (${svc.id})\n`;
      }
    }

    return result;
  },
});

server.tool('railway-create-project', {
  description: 'Create a new Railway project. Requires a workspaceId - use railway-list-workspaces to get available workspaces.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name',
      },
      workspaceId: {
        type: 'string',
        description: 'Workspace ID to create the project in (use railway-list-workspaces to get IDs)',
      },
      description: {
        type: 'string',
        description: 'Optional project description',
      },
    },
    required: ['name', 'workspaceId'],
  },
  handler: async (args, context) => {
    const name = args.name as string;
    const workspaceId = args.workspaceId as string;
    const description = args.description as string | undefined;

    const client = await createClient(context);
    const project = await client.createProject(name, workspaceId, description);

    return {
      message: `Project "${name}" created successfully`,
      projectId: project.id,
      name: project.name,
      workspaceId,
      environments: project.environments.map((e) => ({
        id: e.id,
        name: e.name,
      })),
    };
  },
});

server.tool('railway-delete-project', {
  description: 'Delete a Railway project. This action is irreversible!',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID to delete',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);

    // Get project name for confirmation
    const project = await client.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    await client.deleteProject(projectId);

    return {
      message: `Project "${project.name}" (${projectId}) deleted successfully`,
      deleted: true,
    };
  },
});

// =============================================================================
// ENVIRONMENT TOOLS
// =============================================================================

server.tool('railway-list-environments', {
  description: 'List all environments in a Railway project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);
    const project = await client.getProject(projectId);

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (project.environments.length === 0) {
      return `No environments found in project "${project.name}".`;
    }

    const envList = project.environments
      .map((e) => `- **${e.name}** (${e.id})`)
      .join('\n');

    return `Environments in "${project.name}":\n\n${envList}`;
  },
});

server.tool('railway-create-environment', {
  description:
    'Create a new environment in a Railway project (e.g., staging, production).',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      name: {
        type: 'string',
        description: 'Environment name (e.g., "staging", "production")',
      },
    },
    required: ['projectId', 'name'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const name = args.name as string;

    const client = await createClient(context);
    const environment = await client.createEnvironment(projectId, name);

    return {
      message: `Environment "${name}" created successfully`,
      environmentId: environment.id,
      name: environment.name,
    };
  },
});

// =============================================================================
// SERVICE TOOLS
// =============================================================================

server.tool('railway-list-services', {
  description: 'List all services in a Railway project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);
    const project = await client.getProject(projectId);

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (project.services.length === 0) {
      return `No services found in project "${project.name}".`;
    }

    const svcList = project.services
      .map((s) => `- **${s.name}** (${s.id})`)
      .join('\n');

    return `Services in "${project.name}":\n\n${svcList}`;
  },
});

server.tool('railway-create-service', {
  description: 'Create a new service in a Railway project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      name: {
        type: 'string',
        description: 'Service name (e.g., "web", "api", "worker")',
      },
    },
    required: ['projectId', 'name'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const name = args.name as string;

    const client = await createClient(context);
    const service = await client.createService(projectId, name);

    return {
      message: `Service "${name}" created successfully`,
      serviceId: service.id,
      name: service.name,
    };
  },
});

server.tool('railway-delete-service', {
  description: 'Delete a service from a Railway project.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Railway service ID to delete',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);

    await client.deleteService(serviceId);

    return {
      message: `Service ${serviceId} deleted successfully`,
      deleted: true,
    };
  },
});

// =============================================================================
// VARIABLE TOOLS
// =============================================================================

server.tool('railway-list-variables', {
  description: 'List environment variables for a service.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
    },
    required: ['projectId', 'serviceId', 'environmentId'],
  },
  handler: async (args, context) => {
    const { projectId, serviceId, environmentId } = args as {
      projectId: string;
      serviceId: string;
      environmentId: string;
    };

    const client = await createClient(context);
    const variables = await client.listVariables(
      projectId,
      serviceId,
      environmentId,
    );

    const keys = Object.keys(variables);
    if (keys.length === 0) {
      return 'No environment variables set.';
    }

    // Mask sensitive values
    const masked = keys
      .map((key) => {
        const value = variables[key];
        const display =
          key.toLowerCase().includes('secret') ||
          key.toLowerCase().includes('password') ||
          key.toLowerCase().includes('token') ||
          key.toLowerCase().includes('key')
            ? '***'
            : value.length > 50
              ? value.substring(0, 50) + '...'
              : value;
        return `- **${key}**: ${display}`;
      })
      .join('\n');

    return `Environment variables (${keys.length}):\n\n${masked}`;
  },
});

server.tool('railway-set-variables', {
  description: 'Set environment variables for a service.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
      variables: {
        type: 'object',
        description: 'Key-value pairs of environment variables to set',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['projectId', 'serviceId', 'environmentId', 'variables'],
  },
  handler: async (args, context) => {
    const { projectId, serviceId, environmentId, variables } = args as {
      projectId: string;
      serviceId: string;
      environmentId: string;
      variables: Record<string, string>;
    };

    const client = await createClient(context);
    await client.setVariables(projectId, serviceId, environmentId, variables);

    const keys = Object.keys(variables);
    return {
      message: `Set ${keys.length} variable(s) successfully`,
      variables: keys,
    };
  },
});

// =============================================================================
// DEPLOYMENT TOOLS
// =============================================================================

server.tool('railway-list-deployments', {
  description: 'List recent deployments for a service.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
    },
    required: ['projectId', 'serviceId', 'environmentId'],
  },
  handler: async (args, context) => {
    const { projectId, serviceId, environmentId } = args as {
      projectId: string;
      serviceId: string;
      environmentId: string;
    };

    const client = await createClient(context);
    const deployments = await client.listDeployments(
      projectId,
      serviceId,
      environmentId,
    );

    if (deployments.length === 0) {
      return 'No deployments found.';
    }

    const list = deployments
      .map(
        (d) =>
          `- **${d.id}**: ${d.status} (${d.createdAt})${d.staticUrl ? ` - ${d.staticUrl}` : ''}`,
      )
      .join('\n');

    return `Recent deployments:\n\n${list}`;
  },
});

server.tool('railway-get-deployment', {
  description: 'Get the status of a specific deployment.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: {
        type: 'string',
        description: 'The Railway deployment ID',
      },
    },
    required: ['deploymentId'],
  },
  handler: async (args, context) => {
    const deploymentId = args.deploymentId as string;
    const client = await createClient(context);
    const deployment = await client.getDeployment(deploymentId);

    if (!deployment) {
      throw new Error(`Deployment not found: ${deploymentId}`);
    }

    return {
      id: deployment.id,
      status: deployment.status,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      url: deployment.staticUrl || null,
    };
  },
});

server.tool('railway-redeploy', {
  description: 'Trigger a redeploy of an existing deployment.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: {
        type: 'string',
        description: 'The Railway deployment ID to redeploy',
      },
    },
    required: ['deploymentId'],
  },
  handler: async (args, context) => {
    const deploymentId = args.deploymentId as string;
    const client = await createClient(context);
    const deployment = await client.redeploy(deploymentId);

    return {
      message: 'Redeploy triggered successfully',
      deploymentId: deployment.id,
      status: deployment.status,
    };
  },
});

// =============================================================================
// DOMAIN TOOLS
// =============================================================================

server.tool('railway-list-domains', {
  description: 'List domains for a service.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
    },
    required: ['projectId', 'serviceId', 'environmentId'],
  },
  handler: async (args, context) => {
    const { projectId, serviceId, environmentId } = args as {
      projectId: string;
      serviceId: string;
      environmentId: string;
    };

    const client = await createClient(context);
    const domains = await client.listDomains(
      projectId,
      serviceId,
      environmentId,
    );

    if (domains.length === 0) {
      return 'No domains configured. Use railway-create-domain to create one.';
    }

    const list = domains.map((d) => `- **${d.domain}** (${d.id})`).join('\n');

    return `Domains:\n\n${list}`;
  },
});

server.tool('railway-create-domain', {
  description:
    'Create a Railway-generated domain for a service (e.g., myapp.up.railway.app).',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
    },
    required: ['serviceId', 'environmentId'],
  },
  handler: async (args, context) => {
    const { serviceId, environmentId } = args as {
      serviceId: string;
      environmentId: string;
    };

    const client = await createClient(context);
    const domain = await client.createServiceDomain(serviceId, environmentId);

    return {
      message: 'Domain created successfully',
      domain: domain.domain,
      url: `https://${domain.domain}`,
    };
  },
});

// =============================================================================
// GITHUB CONNECTION TOOLS
// =============================================================================

server.tool('railway-connect-repo', {
  description:
    'Connect a GitHub repository to a Railway service. Works with both public and private repos (if GitHub is connected in your Railway account). Automatically triggers a deployment.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      repo: {
        type: 'string',
        description: 'GitHub repository in format "owner/repo" (e.g., "myuser/myapp")',
      },
      branch: {
        type: 'string',
        description: 'Branch to deploy from (default: "main")',
      },
    },
    required: ['serviceId', 'repo'],
  },
  handler: async (args, context) => {
    const { serviceId, repo, branch = 'main' } = args as {
      serviceId: string;
      repo: string;
      branch?: string;
    };

    const client = await createClient(context);
    const result = await client.connectRepo(serviceId, repo, branch);
    
    return {
      message: `GitHub repository connected successfully`,
      serviceId: result.id,
      serviceName: result.name,
      repo,
      branch,
      note: 'A deployment has been triggered automatically. Use railway-list-deployments to check status.',
    };
  },
});

server.tool('railway-deploy-public-repo', {
  description:
    'Deploy a public GitHub repository to Railway. Creates a new service from the repo. Only works with PUBLIC repositories. For private repos, use railway-connect-repo instead.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      repo: {
        type: 'string',
        description: 'Public GitHub repository in format "owner/repo" (e.g., "myuser/myapp")',
      },
      branch: {
        type: 'string',
        description: 'Branch to deploy from (default: "main")',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID (optional)',
      },
    },
    required: ['projectId', 'repo'],
  },
  handler: async (args, context) => {
    const { projectId, repo, branch = 'main', environmentId } = args as {
      projectId: string;
      repo: string;
      branch?: string;
      environmentId?: string;
    };

    const client = await createClient(context);
    
    try {
      const serviceId = await client.deployPublicRepo(projectId, repo, branch, environmentId);
      
      return {
        message: `Public repository deployed successfully`,
        serviceId,
        repo,
        branch,
        note: 'A new service has been created and deployment triggered.',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('public') || errorMessage.includes('Only public')) {
        throw new Error(
          `This mutation only works with public repositories. For private repos, first create a service with railway-create-service, then use railway-connect-repo to connect your private GitHub repository.`
        );
      }
      throw error;
    }
  },
});

// =============================================================================
// VOLUME TOOLS
// =============================================================================

server.tool('railway-create-volume', {
  description:
    'Create a persistent volume for a service (useful for databases).',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Railway project ID',
      },
      serviceId: {
        type: 'string',
        description: 'The Railway service ID',
      },
      environmentId: {
        type: 'string',
        description: 'The Railway environment ID',
      },
      mountPath: {
        type: 'string',
        description: 'Path to mount the volume (e.g., "/data/db" for MongoDB)',
      },
    },
    required: ['projectId', 'serviceId', 'environmentId', 'mountPath'],
  },
  handler: async (args, context) => {
    const { projectId, serviceId, environmentId, mountPath } = args as {
      projectId: string;
      serviceId: string;
      environmentId: string;
      mountPath: string;
    };

    const client = await createClient(context);
    const volume = await client.createVolume(
      projectId,
      serviceId,
      environmentId,
      mountPath,
    );

    return {
      message: 'Volume created successfully',
      volumeId: volume.id,
      name: volume.name,
      mountPath,
    };
  },
});

// =============================================================================
// LOG TOOLS
// =============================================================================

server.tool('railway-get-build-logs', {
  description:
    'Get build logs for a deployment. Shows what happened during the build/compile phase.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: {
        type: 'string',
        description: 'The deployment ID to get build logs for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of log lines to return (default: 100, max: 500)',
        default: 100,
      },
      filter: {
        type: 'string',
        description: 'Optional text filter to search within logs',
      },
    },
    required: ['deploymentId'],
  },
  handler: async (args, context) => {
    const { deploymentId, limit = 100, filter } = args as {
      deploymentId: string;
      limit?: number;
      filter?: string;
    };

    const client = await createClient(context);
    const result = await client.getBuildLogs(
      deploymentId,
      Math.min(limit, 500),
      filter,
    );

    if (result.logs.length === 0) {
      return `No build logs found for deployment ${deploymentId}${filter ? ` matching "${filter}"` : ''}.`;
    }

    const formattedLogs = result.logs
      .map((log) => {
        const severity = log.severity ? `[${log.severity}]` : '';
        const time = new Date(log.timestamp).toISOString().split('T')[1].split('.')[0];
        return `${time} ${severity} ${log.message}`;
      })
      .join('\n');

    return `Build logs for deployment ${deploymentId} (${result.total} lines):\n\n\`\`\`\n${formattedLogs}\n\`\`\``;
  },
});

server.tool('railway-get-deploy-logs', {
  description:
    'Get runtime/deployment logs for a deployment. Shows application output, errors, and startup logs.',
  parameters: {
    type: 'object',
    properties: {
      deploymentId: {
        type: 'string',
        description: 'The deployment ID to get runtime logs for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of log lines to return (default: 100, max: 500)',
        default: 100,
      },
      filter: {
        type: 'string',
        description: 'Optional text filter to search within logs',
      },
    },
    required: ['deploymentId'],
  },
  handler: async (args, context) => {
    const { deploymentId, limit = 100, filter } = args as {
      deploymentId: string;
      limit?: number;
      filter?: string;
    };

    const client = await createClient(context);
    const result = await client.getDeploymentLogs(
      deploymentId,
      Math.min(limit, 500),
      filter,
    );

    if (result.logs.length === 0) {
      return `No runtime logs found for deployment ${deploymentId}${filter ? ` matching "${filter}"` : ''}.`;
    }

    const formattedLogs = result.logs
      .map((log) => {
        const severity = log.severity ? `[${log.severity}]` : '';
        const time = new Date(log.timestamp).toISOString().split('T')[1].split('.')[0];
        return `${time} ${severity} ${log.message}`;
      })
      .join('\n');

    return `Runtime logs for deployment ${deploymentId} (${result.total} lines):\n\n\`\`\`\n${formattedLogs}\n\`\`\``;
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🚂 Railway MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Railway MCA:', error);
    process.exit(1);
  });
