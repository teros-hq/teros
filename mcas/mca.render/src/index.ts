#!/usr/bin/env npx tsx

/**
 * Render MCA
 *
 * Deploy and manage services on Render directly from Teros workspaces.
 * Supports web services, static sites, deployments, environment variables,
 * custom domains, disks, and project/environment management.
 *
 * Uses @teros/mca-sdk McaServer with HTTP transport.
 * User credentials (RENDER_API_KEY) are fetched on-demand from the backend.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { RenderClient } from './render-client.js';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Get Render API key from user secrets
 */
function getApiKey(secrets: Record<string, string>): string | null {
  return secrets.RENDER_API_KEY || secrets.renderApiKey || null;
}

/**
 * Create a Render client from context
 */
async function createClient(context: any): Promise<RenderClient> {
  const secrets = await context.getUserSecrets();
  const apiKey = getApiKey(secrets);

  if (!apiKey) {
    throw new Error(
      'Render API key not configured. Please add your RENDER_API_KEY in the app settings. Get your key from https://dashboard.render.com/u/settings#api-keys',
    );
  }

  return new RenderClient(apiKey);
}

/**
 * Format a service for display
 */
function formatService(svc: any): string {
  const url = svc.serviceDetails?.url ?? '';
  const type = svc.type ?? 'unknown';
  const status = svc.status ?? 'unknown';
  const region = svc.serviceDetails?.region ?? '';
  return `**${svc.name}** (${svc.id})
  - Type: ${type} | Status: ${status}${region ? ` | Region: ${region}` : ''}${url ? `\n  - URL: ${url}` : ''}
  - Created: ${svc.createdAt}`;
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.render',
  name: 'Render',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Render API key and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const secrets = await context.getUserSecrets();
      const apiKey = getApiKey(secrets);

      if (!apiKey) {
        builder.addIssue('USER_CONFIG_MISSING', 'Render API key not configured', {
          type: 'user_action',
          description:
            'Add your RENDER_API_KEY in the app settings. Get your key from https://dashboard.render.com/u/settings#api-keys',
        });
      } else {
        const client = new RenderClient(apiKey);
        const isValid = await client.validateApiKey();

        if (!isValid) {
          builder.addIssue('USER_CONFIG_INVALID', 'Render API key is invalid', {
            type: 'user_action',
            description:
              'Your Render API key is invalid or expired. Generate a new one at https://dashboard.render.com/u/settings#api-keys',
          });
        }
      }
    } catch (error) {
      builder.addIssue(
        'CONNECTIVITY_ERROR',
        error instanceof Error ? error.message : 'Failed to connect to Render',
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
// USER & OWNER TOOLS
// =============================================================================

server.tool('render-get-user', {
  annotations: { readOnlyHint: true },
  description: 'Get the authenticated Render user info.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const user = await client.getUser();

    let result = `# Render User\n\n`;
    result += `- **Name**: ${user.name}\n`;
    result += `- **Email**: ${user.email}\n`;
    result += `- **ID**: ${user.id}\n`;

    return result;
  },
});

server.tool('render-list-owners', {
  annotations: { readOnlyHint: true },
  description: 'List all workspaces/owners (personal and team accounts) accessible to the authenticated user.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const owners = await client.listOwners();

    if (owners.length === 0) {
      return 'No workspaces found.';
    }

    const list = owners
      .map((o) => `- **${o.name}** (${o.id}) — ${o.type}`)
      .join('\n');

    return `Workspaces/Owners:\n\n${list}`;
  },
});

// =============================================================================
// PROJECT TOOLS
// =============================================================================

server.tool('render-list-projects', {
  annotations: { readOnlyHint: true },
  description: 'List all projects in the Render account.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const client = await createClient(context);
    const projects = await client.listProjects();

    if (projects.length === 0) {
      return 'No projects found. Use render-create-project to create one.';
    }

    const list = projects
      .map((p) => `- **${p.name}** (${p.id}) — Created: ${p.createdAt}`)
      .join('\n');

    return `Found ${projects.length} project(s):\n\n${list}`;
  },
});

server.tool('render-get-project', {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific Render project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Render project ID',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);
    const project = await client.getProject(projectId);

    let result = `# Project: ${project.name}\n\n`;
    result += `- **ID**: ${project.id}\n`;
    result += `- **Owner ID**: ${project.ownerId}\n`;
    result += `- **Created**: ${project.createdAt}\n`;
    result += `- **Updated**: ${project.updatedAt}\n`;

    return result;
  },
});

server.tool('render-create-project', {
  annotations: { readOnlyHint: false },
  description: 'Create a new project in Render. Use render-list-owners to get the ownerId.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name',
      },
      ownerId: {
        type: 'string',
        description: 'Owner/workspace ID (use render-list-owners to get IDs)',
      },
    },
    required: ['name', 'ownerId'],
  },
  handler: async (args, context) => {
    const { name, ownerId } = args as { name: string; ownerId: string };
    const client = await createClient(context);
    const project = await client.createProject(name, ownerId);

    return {
      message: `Project "${name}" created successfully`,
      projectId: project.id,
      name: project.name,
      ownerId: project.ownerId,
    };
  },
});

server.tool('render-delete-project', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a Render project. This action is irreversible!',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Render project ID to delete',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);

    const project = await client.getProject(projectId);
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

server.tool('render-list-environments', {
  annotations: { readOnlyHint: true },
  description: 'List all environments in a Render project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Render project ID',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const projectId = args.projectId as string;
    const client = await createClient(context);
    const environments = await client.listEnvironments(projectId);

    if (environments.length === 0) {
      return `No environments found in project ${projectId}.`;
    }

    const list = environments
      .map((e) => `- **${e.name}** (${e.id})`)
      .join('\n');

    return `Environments:\n\n${list}`;
  },
});

server.tool('render-create-environment', {
  annotations: { readOnlyHint: false },
  description: 'Create a new environment in a Render project.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Render project ID',
      },
      name: {
        type: 'string',
        description: 'Environment name (e.g., "staging", "production")',
      },
    },
    required: ['projectId', 'name'],
  },
  handler: async (args, context) => {
    const { projectId, name } = args as { projectId: string; name: string };
    const client = await createClient(context);
    const environment = await client.createEnvironment(projectId, name);

    return {
      message: `Environment "${name}" created successfully`,
      environmentId: environment.id,
      name: environment.name,
      projectId: environment.projectId,
    };
  },
});

// =============================================================================
// SERVICE TOOLS
// =============================================================================

server.tool('render-list-services', {
  annotations: { readOnlyHint: true },
  description: 'List all services in the Render account. Optionally filter by type or name.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Filter by service type: web_service, static_site, background_worker, private_service, cron_job',
      },
      name: {
        type: 'string',
        description: 'Filter by service name (partial match)',
      },
    },
  },
  handler: async (args, context) => {
    const { type, name } = args as { type?: string; name?: string };
    const client = await createClient(context);
    const services = await client.listServices({ type, name });

    if (services.length === 0) {
      return 'No services found. Use render-create-service to create one.';
    }

    const formatted = services.map(formatService).join('\n\n');
    return `Found ${services.length} service(s):\n\n${formatted}`;
  },
});

server.tool('render-get-service', {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    const svc = await client.getService(serviceId);

    let result = `# Service: ${svc.name}\n\n`;
    result += `- **ID**: ${svc.id}\n`;
    result += `- **Type**: ${svc.type}\n`;
    result += `- **Status**: ${svc.status}\n`;
    result += `- **Slug**: ${svc.slug}\n`;
    result += `- **Owner ID**: ${svc.ownerId}\n`;
    result += `- **Created**: ${svc.createdAt}\n`;
    result += `- **Updated**: ${svc.updatedAt}\n`;

    if (svc.serviceDetails) {
      result += `\n## Service Details\n`;
      const d = svc.serviceDetails;
      if (d.url) result += `- **URL**: ${d.url}\n`;
      if (d.repoURL) result += `- **Repo**: ${d.repoURL}\n`;
      if (d.branch) result += `- **Branch**: ${d.branch}\n`;
      if (d.region) result += `- **Region**: ${d.region}\n`;
      if (d.plan) result += `- **Plan**: ${d.plan}\n`;
      if (d.buildCommand) result += `- **Build Command**: \`${d.buildCommand}\`\n`;
      if (d.startCommand) result += `- **Start Command**: \`${d.startCommand}\`\n`;
      if (d.autoDeploy) result += `- **Auto Deploy**: ${d.autoDeploy}\n`;
    }

    return result;
  },
});

server.tool('render-create-service', {
  annotations: { readOnlyHint: false },
  description: 'Create a new service on Render from a GitHub repository. Use render-list-owners to get ownerId.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Service name',
      },
      ownerId: {
        type: 'string',
        description: 'Owner/workspace ID (use render-list-owners to get IDs)',
      },
      type: {
        type: 'string',
        description: 'Service type: web_service, static_site, background_worker, private_service, cron_job',
      },
      repoURL: {
        type: 'string',
        description: 'GitHub repository URL (e.g., "https://github.com/owner/repo")',
      },
      branch: {
        type: 'string',
        description: 'Branch to deploy from (default: "main")',
      },
      buildCommand: {
        type: 'string',
        description: 'Build command (e.g., "npm run build")',
      },
      startCommand: {
        type: 'string',
        description: 'Start command for web/worker services (e.g., "node server.js")',
      },
      plan: {
        type: 'string',
        description: 'Instance plan (e.g., "free", "starter", "standard", "pro")',
      },
      region: {
        type: 'string',
        description: 'Deployment region (e.g., "oregon", "frankfurt", "singapore")',
      },
      autoDeploy: {
        type: 'string',
        description: 'Auto-deploy on git push: "yes" or "no" (default: "yes")',
      },
    },
    required: ['name', 'ownerId', 'type', 'repoURL'],
  },
  handler: async (args, context) => {
    const input = args as {
      name: string;
      ownerId: string;
      type: 'web_service' | 'static_site' | 'background_worker' | 'private_service' | 'cron_job';
      repoURL: string;
      branch?: string;
      buildCommand?: string;
      startCommand?: string;
      plan?: string;
      region?: string;
      autoDeploy?: 'yes' | 'no';
    };

    const client = await createClient(context);
    const result = await client.createService(input);

    return {
      message: `Service "${input.name}" created successfully`,
      serviceId: result.service.id,
      name: result.service.name,
      type: result.service.type,
      status: result.service.status,
      deployId: result.deployId,
      note: result.deployId
        ? 'A deployment has been triggered. Use render-get-deploy to check status.'
        : 'Service created. Trigger a deploy with render-trigger-deploy.',
    };
  },
});

server.tool('render-delete-service', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Delete a Render service. This action is irreversible!',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID to delete',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);

    const svc = await client.getService(serviceId);
    await client.deleteService(serviceId);

    return {
      message: `Service "${svc.name}" (${serviceId}) deleted successfully`,
      deleted: true,
    };
  },
});

server.tool('render-suspend-service', {
  annotations: { readOnlyHint: false },
  description: 'Suspend a running Render service (stops billing for compute).',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID to suspend',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    await client.suspendService(serviceId);

    return {
      message: `Service ${serviceId} suspended successfully`,
      suspended: true,
    };
  },
});

server.tool('render-resume-service', {
  annotations: { readOnlyHint: false },
  description: 'Resume a suspended Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID to resume',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    await client.resumeService(serviceId);

    return {
      message: `Service ${serviceId} resumed successfully`,
      resumed: true,
    };
  },
});

server.tool('render-restart-service', {
  annotations: { readOnlyHint: false },
  description: 'Restart a running Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID to restart',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    await client.restartService(serviceId);

    return {
      message: `Service ${serviceId} restarted successfully`,
      restarted: true,
    };
  },
});

// =============================================================================
// DEPLOYMENT TOOLS
// =============================================================================

server.tool('render-list-deploys', {
  annotations: { readOnlyHint: false },
  description: 'List recent deploys for a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of deploys to return (default: 10, max: 100)',
        default: 10,
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const { serviceId, limit = 10 } = args as { serviceId: string; limit?: number };
    const client = await createClient(context);
    const deploys = await client.listDeploys(serviceId, Math.min(limit, 100));

    if (deploys.length === 0) {
      return 'No deploys found for this service.';
    }

    const list = deploys
      .map((d) => {
        const commit = d.commit ? ` — \`${d.commit.message?.substring(0, 60)}\`` : '';
        return `- **${d.id}**: ${d.status} (${d.createdAt})${commit}`;
      })
      .join('\n');

    return `Recent deploys:\n\n${list}`;
  },
});

server.tool('render-get-deploy', {
  annotations: { readOnlyHint: false },
  description: 'Get the status and details of a specific Render deploy.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      deployId: {
        type: 'string',
        description: 'The Render deploy ID',
      },
    },
    required: ['serviceId', 'deployId'],
  },
  handler: async (args, context) => {
    const { serviceId, deployId } = args as { serviceId: string; deployId: string };
    const client = await createClient(context);
    const deploy = await client.getDeploy(serviceId, deployId);

    return {
      id: deploy.id,
      serviceId: deploy.serviceId,
      status: deploy.status,
      trigger: deploy.trigger,
      createdAt: deploy.createdAt,
      updatedAt: deploy.updatedAt,
      finishedAt: deploy.finishedAt ?? null,
      commit: deploy.commit ?? null,
    };
  },
});

server.tool('render-trigger-deploy', {
  annotations: { readOnlyHint: false },
  description: 'Trigger a new deploy for a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      clearCache: {
        type: 'string',
        description: 'Whether to clear the build cache: "clear" or "do_not_clear" (default: do_not_clear)',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const { serviceId, clearCache } = args as {
      serviceId: string;
      clearCache?: 'clear' | 'do_not_clear';
    };

    const client = await createClient(context);
    const deploy = await client.triggerDeploy(serviceId, clearCache);

    return {
      message: 'Deploy triggered successfully',
      deployId: deploy.id,
      status: deploy.status,
      createdAt: deploy.createdAt,
    };
  },
});

server.tool('render-cancel-deploy', {
  annotations: { readOnlyHint: false, irreversible: true },
  description: 'Cancel a running Render deploy.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      deployId: {
        type: 'string',
        description: 'The Render deploy ID to cancel',
      },
    },
    required: ['serviceId', 'deployId'],
  },
  handler: async (args, context) => {
    const { serviceId, deployId } = args as { serviceId: string; deployId: string };
    const client = await createClient(context);
    await client.cancelDeploy(serviceId, deployId);

    return {
      message: `Deploy ${deployId} cancelled successfully`,
      cancelled: true,
    };
  },
});

server.tool('render-rollback-deploy', {
  annotations: { readOnlyHint: false },
  description: 'Roll back a Render service to a specific previous deploy.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      deployId: {
        type: 'string',
        description: 'The deploy ID to roll back to',
      },
    },
    required: ['serviceId', 'deployId'],
  },
  handler: async (args, context) => {
    const { serviceId, deployId } = args as { serviceId: string; deployId: string };
    const client = await createClient(context);
    const deploy = await client.rollbackDeploy(serviceId, deployId);

    return {
      message: `Rollback to deploy ${deployId} triggered successfully`,
      newDeployId: deploy.id,
      status: deploy.status,
    };
  },
});

// =============================================================================
// ENVIRONMENT VARIABLE TOOLS
// =============================================================================

server.tool('render-list-env-vars', {
  annotations: { readOnlyHint: true },
  description: 'List environment variables for a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    const envVars = await client.listEnvVars(serviceId);

    if (envVars.length === 0) {
      return 'No environment variables set.';
    }

    const masked = envVars
      .map(({ key, value }) => {
        const isSensitive =
          key.toLowerCase().includes('secret') ||
          key.toLowerCase().includes('password') ||
          key.toLowerCase().includes('token') ||
          key.toLowerCase().includes('key') ||
          key.toLowerCase().includes('api');
        const display = isSensitive ? '***' : value.length > 50 ? value.substring(0, 50) + '...' : value;
        return `- **${key}**: ${display}`;
      })
      .join('\n');

    return `Environment variables (${envVars.length}):\n\n${masked}`;
  },
});

server.tool('render-set-env-vars', {
  annotations: { readOnlyHint: false },
  description:
    'Set (replace all) environment variables for a Render service. This replaces ALL existing variables. Use render-update-env-var to update a single variable.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      envVars: {
        type: 'array',
        description: 'Array of environment variables to set',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key', 'value'],
        },
      },
    },
    required: ['serviceId', 'envVars'],
  },
  handler: async (args, context) => {
    const { serviceId, envVars } = args as {
      serviceId: string;
      envVars: { key: string; value: string }[];
    };

    const client = await createClient(context);
    await client.updateEnvVars(serviceId, envVars);

    return {
      message: `Set ${envVars.length} environment variable(s) successfully`,
      keys: envVars.map((e) => e.key),
    };
  },
});

server.tool('render-update-env-var', {
  annotations: { readOnlyHint: false },
  description: 'Add or update a single environment variable for a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      key: {
        type: 'string',
        description: 'Environment variable key',
      },
      value: {
        type: 'string',
        description: 'Environment variable value',
      },
    },
    required: ['serviceId', 'key', 'value'],
  },
  handler: async (args, context) => {
    const { serviceId, key, value } = args as { serviceId: string; key: string; value: string };
    const client = await createClient(context);
    await client.setEnvVar(serviceId, key, value);

    return {
      message: `Environment variable "${key}" updated successfully`,
      key,
    };
  },
});

server.tool('render-delete-env-var', {
  annotations: { readOnlyHint: false },
  description: 'Delete an environment variable from a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      key: {
        type: 'string',
        description: 'Environment variable key to delete',
      },
    },
    required: ['serviceId', 'key'],
  },
  handler: async (args, context) => {
    const { serviceId, key } = args as { serviceId: string; key: string };
    const client = await createClient(context);
    await client.deleteEnvVar(serviceId, key);

    return {
      message: `Environment variable "${key}" deleted successfully`,
      deleted: true,
    };
  },
});

// =============================================================================
// CUSTOM DOMAIN TOOLS
// =============================================================================

server.tool('render-list-custom-domains', {
  annotations: { readOnlyHint: true },
  description: 'List custom domains configured for a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    const domains = await client.listCustomDomains(serviceId);

    if (domains.length === 0) {
      return 'No custom domains configured. Use render-add-custom-domain to add one.';
    }

    const list = domains
      .map((d) => `- **${d.name}** (${d.id}) — Status: ${d.verificationStatus}`)
      .join('\n');

    return `Custom domains:\n\n${list}`;
  },
});

server.tool('render-add-custom-domain', {
  annotations: { readOnlyHint: false },
  description: 'Add a custom domain to a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      domain: {
        type: 'string',
        description: 'The custom domain name (e.g., "app.example.com")',
      },
    },
    required: ['serviceId', 'domain'],
  },
  handler: async (args, context) => {
    const { serviceId, domain } = args as { serviceId: string; domain: string };
    const client = await createClient(context);
    const result = await client.addCustomDomain(serviceId, domain);

    return {
      message: `Custom domain "${domain}" added successfully`,
      domainId: result.id,
      name: result.name,
      verificationStatus: result.verificationStatus,
    };
  },
});

server.tool('render-delete-custom-domain', {
  annotations: { readOnlyHint: false },
  description: 'Remove a custom domain from a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      domainId: {
        type: 'string',
        description: 'The custom domain ID to remove',
      },
    },
    required: ['serviceId', 'domainId'],
  },
  handler: async (args, context) => {
    const { serviceId, domainId } = args as { serviceId: string; domainId: string };
    const client = await createClient(context);
    await client.deleteCustomDomain(serviceId, domainId);

    return {
      message: `Custom domain ${domainId} removed successfully`,
      deleted: true,
    };
  },
});

server.tool('render-verify-custom-domain', {
  annotations: { readOnlyHint: false },
  description: 'Verify DNS configuration for a custom domain on a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      domainId: {
        type: 'string',
        description: 'The custom domain ID to verify',
      },
    },
    required: ['serviceId', 'domainId'],
  },
  handler: async (args, context) => {
    const { serviceId, domainId } = args as { serviceId: string; domainId: string };
    const client = await createClient(context);
    const result = await client.verifyCustomDomain(serviceId, domainId);

    return {
      domainId: result.id,
      name: result.name,
      verificationStatus: result.verificationStatus,
      message:
        result.verificationStatus === 'verified'
          ? `Domain "${result.name}" is verified and active`
          : `Domain "${result.name}" verification status: ${result.verificationStatus}. Check your DNS settings.`,
    };
  },
});

// =============================================================================
// DISK TOOLS
// =============================================================================

server.tool('render-list-disks', {
  annotations: { readOnlyHint: true },
  description: 'List persistent disks attached to a Render service.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
    },
    required: ['serviceId'],
  },
  handler: async (args, context) => {
    const serviceId = args.serviceId as string;
    const client = await createClient(context);
    const disks = await client.listDisks(serviceId);

    if (disks.length === 0) {
      return 'No disks attached. Use render-add-disk to add a persistent disk.';
    }

    const list = disks
      .map((d) => `- **${d.name}** (${d.id}) — Mount: \`${d.mountPath}\` | Size: ${d.sizeGB}GB`)
      .join('\n');

    return `Disks:\n\n${list}`;
  },
});

server.tool('render-add-disk', {
  annotations: { readOnlyHint: false },
  description: 'Add a persistent disk to a Render service (useful for databases and stateful apps).',
  parameters: {
    type: 'object',
    properties: {
      serviceId: {
        type: 'string',
        description: 'The Render service ID',
      },
      name: {
        type: 'string',
        description: 'Disk name',
      },
      mountPath: {
        type: 'string',
        description: 'Mount path inside the container (e.g., "/data")',
      },
      sizeGB: {
        type: 'number',
        description: 'Disk size in GB (minimum: 1)',
      },
    },
    required: ['serviceId', 'name', 'mountPath', 'sizeGB'],
  },
  handler: async (args, context) => {
    const { serviceId, name, mountPath, sizeGB } = args as {
      serviceId: string;
      name: string;
      mountPath: string;
      sizeGB: number;
    };

    const client = await createClient(context);
    const disk = await client.addDisk(serviceId, name, mountPath, sizeGB);

    return {
      message: `Disk "${name}" added successfully`,
      diskId: disk.id,
      name: disk.name,
      mountPath: disk.mountPath,
      sizeGB: disk.sizeGB,
    };
  },
});

// =============================================================================
// LOG TOOLS
// =============================================================================

server.tool('render-get-logs', {
  annotations: { readOnlyHint: true },
  description:
    'Get recent logs for one or more Render services. Requires the owner ID (use render-list-owners) and service IDs.',
  parameters: {
    type: 'object',
    properties: {
      ownerId: {
        type: 'string',
        description: 'The owner/workspace ID (use render-list-owners to get IDs)',
      },
      serviceIds: {
        type: 'array',
        description: 'Array of service IDs to get logs from',
        items: { type: 'string' },
      },
      limit: {
        type: 'number',
        description: 'Maximum number of log lines to return (default: 100)',
        default: 100,
      },
      text: {
        type: 'string',
        description: 'Filter logs containing this text',
      },
      level: {
        type: 'string',
        description: 'Filter by log level: debug, info, warning, error',
      },
    },
    required: ['ownerId', 'serviceIds'],
  },
  handler: async (args, context) => {
    const { ownerId, serviceIds, limit = 100, text, level } = args as {
      ownerId: string;
      serviceIds: string[];
      limit?: number;
      text?: string;
      level?: string;
    };

    const client = await createClient(context);
    const logs = await client.getLogs(ownerId, serviceIds, Math.min(limit, 500), undefined, undefined, text, level);

    if (!logs || logs.length === 0) {
      return `No logs found${text ? ` matching "${text}"` : ''}.`;
    }

    const formatted = logs
      .map((log: any) => {
        const ts = new Date(log.timestamp).toISOString().split('T')[1].split('.')[0];
        const lvl = log.level ? `[${log.level.toUpperCase()}]` : '';
        return `${ts} ${lvl} ${log.message}`;
      })
      .join('\n');

    return `Logs (${logs.length} lines):\n\n\`\`\`\n${formatted}\n\`\`\``;
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🚀 Render MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Render MCA:', error);
    process.exit(1);
  });
