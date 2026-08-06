#!/usr/bin/env npx tsx

/**
 * Teros Core MCA
 *
 * Manage Teros platform resources: agents, workspaces, apps, and access control.
 * Provides tools to create, update, and configure the platform.
 *
 * Uses @teros/mca-sdk McaHttpServer for HTTP transport.
 * Resources are scoped to the authenticated user via callbackUrl endpoints.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import {
  // Access Control
  accessGrant,
  accessRevoke,
  agentAppsList,
  agentCreate,
  agentDelete,
  agentGet,
  // Agents
  agentList,
  agentPreferredProviderSet,
  agentProvidersGet,
  agentProvidersSet,
  agentUpdate,
  appAccessList,
  appCheckAuth,
  appGet,
  appInstall,
  // Apps
  appList,
  // Permissions
  appPermissionsGet,
  appPermissionsSet,
  appRename,
  appShowAuth,
  appUninstall,
  // Catalog
  catalogList,
  // Providers
  providerList,
  // Skills
  skillCreate,
  skillDelete,
  skillGetAgentSkills,
  skillGrantAccess,
  skillList,
  skillRevokeAccess,
  skillSetEnabled,
  skillUpdate,
  workspaceAgentList,
  workspaceAppList,
  workspaceArchive,
  workspaceCreate,
  workspaceGet,
  // Workspaces
  workspaceList,
  workspaceMemberAdd,
  workspaceMemberRemove,
  workspaceMemberUpdate,
  workspaceUpdate,
} from './tools';

// =============================================================================
// MCA HTTP SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.core',
  name: 'Teros Core',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies connectivity to backend.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      // Test that we can reach the backend
      await context.agentList();
    } catch (error) {
      builder.addIssue(
        'BACKEND_UNAVAILABLE',
        error instanceof Error ? error.message : 'Failed to connect to backend',
        {
          type: 'auto_retry',
          description: 'Backend temporarily unavailable',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: AGENTS
// =============================================================================

server.tool('list-agents', agentList);
server.tool('get-agent', agentGet);
server.tool('create-agent', agentCreate);
server.tool('update-agent', agentUpdate);
server.tool('delete-agent', agentDelete);
server.tool('list-agent-apps', agentAppsList);
server.tool('get-agent-providers', agentProvidersGet);
server.tool('set-agent-providers', agentProvidersSet);
server.tool('set-agent-preferred-provider', agentPreferredProviderSet);

// =============================================================================
// REGISTER TOOLS: WORKSPACES
// =============================================================================

server.tool('list-workspaces', workspaceList);
server.tool('get-workspace', workspaceGet);
server.tool('create-workspace', workspaceCreate);
server.tool('update-workspace', workspaceUpdate);
server.tool('archive-workspace', workspaceArchive);
server.tool('add-workspace-member', workspaceMemberAdd);
server.tool('remove-workspace-member', workspaceMemberRemove);
server.tool('update-workspace-member-role', workspaceMemberUpdate);

// =============================================================================
// REGISTER TOOLS: APPS
// =============================================================================

server.tool('list-apps', appList);
server.tool('get-app', appGet);
server.tool('install-app', appInstall);
server.tool('uninstall-app', appUninstall);
server.tool('rename-app', appRename);
server.tool('check-app-auth', appCheckAuth);
server.tool('show-app-auth', appShowAuth);
server.tool('list-app-access', appAccessList);
server.tool('workspace-app-list', workspaceAppList);
server.tool('workspace-agent-list', workspaceAgentList);

// =============================================================================
// REGISTER TOOLS: CATALOG
// =============================================================================

server.tool('list-catalog', catalogList);

// =============================================================================
// REGISTER TOOLS: PROVIDERS
// =============================================================================

server.tool('list-providers', providerList);

// =============================================================================
// REGISTER TOOLS: ACCESS CONTROL
// =============================================================================

server.tool('grant-app-access', accessGrant);
server.tool('revoke-app-access', accessRevoke);

// =============================================================================
// REGISTER TOOLS: TOOL PERMISSIONS
// =============================================================================

server.tool('get-app-permissions', appPermissionsGet);
server.tool('set-app-permissions', appPermissionsSet);

// =============================================================================
// REGISTER TOOLS: SKILLS
// =============================================================================

server.tool('skill-list', skillList);
server.tool('skill-create', skillCreate);
server.tool('skill-update', skillUpdate);
server.tool('skill-delete', skillDelete);
server.tool('skill-grant-access', skillGrantAccess);
server.tool('skill-revoke-access', skillRevokeAccess);
server.tool('skill-set-enabled', skillSetEnabled);
server.tool('skill-get-agent-skills', skillGetAgentSkills);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔧 Teros Core MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start Teros Core MCA:', error);
    process.exit(1);
  });
