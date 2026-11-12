#!/usr/bin/env bun

/**
 * Teros Admin Panel MCA v3.0
 *
 * Full administrative panel exposed via chat:
 * - Agents, Workspaces, Apps, Access management
 * - Catalog browsing
 * - Usage analytics
 * - Feature flags
 *
 * Transport: WebSocket (admin_request via WsRouter admin-api domain)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { disconnectWsClient, initializeWsClient, isWsConnected } from './lib/index.js';
import {
  // Agents
  adminAgentsList,
  adminAgentsGet,
  adminAgentsCreate,
  adminAgentsUpdate,
  adminAgentsDelete,
  // Workspaces
  adminWorkspacesList,
  adminWorkspacesGet,
  adminWorkspacesCreate,
  adminWorkspacesUpdate,
  adminWorkspacesArchive,
  adminWorkspacesMembersAdd,
  adminWorkspacesMembersRemove,
  adminWorkspacesMembersUpdate,
  // Apps
  adminAppsList,
  adminAppsGet,
  adminAppsCreate,
  adminAppsUpdate,
  adminAppsDelete,
  adminAppsGetAccess,
  adminAppsSetPermissions,
  adminAppsCopyAuth,
  // Access
  adminAccessList,
  adminAccessGrant,
  adminAccessRevoke,
  // Users (waitlist access + roles)
  adminUsersGrantAccess,
  adminUsersUpdateRole,
  // Catalog
  adminCatalogGet,
  adminCatalogList,
  // System
  adminActiveSessions,
  adminRefreshClients,
  // Usage
  adminUsageSummary,
  adminUsageByUser,
  adminUsageByWorkspace,
  adminUsageByAgent,
  adminUsageByModel,
  adminUsageExpensiveConversations,
  adminUsageTimeline,
  adminUsageSessions,
  adminUsageSessionDetail,
  // LLM Health & Observability
  adminModelHealth,
  adminModelHealthTimeseries,
  adminUpstreamErrors,
  adminInFlight,
  adminProviderStatus,
  // Feature Flags
  adminFeatureFlagsList,
  adminFeatureFlagsGet,
  adminFeatureFlagsUpdate,
  adminFeatureFlagsResetDefault,
  adminFeatureFlagsGetOverrides,
  adminFeatureFlagsSetOverride,
  adminFeatureFlagsDeleteOverride,
} from './tools/index.js';

const MCA_APP_ID = process.env.MCA_APP_ID || 'unknown';
const MCA_APP_NAME = process.env.MCA_APP_NAME || 'teros-admin';

const server = new McaServer({
  id: 'mca.teros.admin',
  name: 'Teros Admin',
  version: '3.0.0',
});

// Health check
server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies WebSocket connectivity to backend.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const builder = new HealthCheckBuilder({}).setVersion('3.0.0');

    if (!isWsConnected()) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'Not connected to backend WebSocket', {
        type: 'auto_retry',
        description: 'WebSocket connection to backend is not established',
      });
    }

    return builder.build();
  },
});

// ── Agents ──
server.tool('admin-agents-list', adminAgentsList);
server.tool('admin-agents-get', adminAgentsGet);
server.tool('admin-agents-create', adminAgentsCreate);
server.tool('admin-agents-update', adminAgentsUpdate);
server.tool('admin-agents-delete', adminAgentsDelete);

// ── Workspaces ──
server.tool('admin-workspaces-list', adminWorkspacesList);
server.tool('admin-workspaces-get', adminWorkspacesGet);
server.tool('admin-workspaces-create', adminWorkspacesCreate);
server.tool('admin-workspaces-update', adminWorkspacesUpdate);
server.tool('admin-workspaces-archive', adminWorkspacesArchive);
server.tool('admin-workspaces-members-add', adminWorkspacesMembersAdd);
server.tool('admin-workspaces-members-remove', adminWorkspacesMembersRemove);
server.tool('admin-workspaces-members-update', adminWorkspacesMembersUpdate);

// ── Apps ──
server.tool('admin-apps-list', adminAppsList);
server.tool('admin-apps-get', adminAppsGet);
server.tool('admin-apps-create', adminAppsCreate);
server.tool('admin-apps-update', adminAppsUpdate);
server.tool('admin-apps-delete', adminAppsDelete);
server.tool('admin-apps-get-access', adminAppsGetAccess);
server.tool('admin-apps-set-permissions', adminAppsSetPermissions);
// admin replica of copy-app-auth (tn_aGVdSrVwIJi9mfvc) — alwaysAsk, masked summary only.
server.tool('admin-apps-copy-auth', adminAppsCopyAuth);

// ── Access ──
server.tool('admin-access-list', adminAccessList);
server.tool('admin-access-grant', adminAccessGrant);
server.tool('admin-access-revoke', adminAccessRevoke);

// ── Users (waitlist access + roles) — tn_h3KIMygPUs0nvl5F, Pablo 2-nov ──
// Actions on people: alwaysAsk (confirmation on every call), same policy as
// admin-apps-set-permissions.
server.tool('admin-users-grant-access', adminUsersGrantAccess);
server.tool('admin-users-update-role', adminUsersUpdateRole);

// ── Catalog ──
server.tool('admin-catalog-list', adminCatalogList);
server.tool('admin-catalog-get', adminCatalogGet);

// ── System ──
server.tool('admin-active-sessions', adminActiveSessions);
server.tool('admin-refresh-clients', adminRefreshClients);

// ── Usage ──
server.tool('admin-usage-summary', adminUsageSummary);
server.tool('admin-usage-by-user', adminUsageByUser);
server.tool('admin-usage-by-workspace', adminUsageByWorkspace);
server.tool('admin-usage-by-agent', adminUsageByAgent);
server.tool('admin-usage-by-model', adminUsageByModel);
server.tool('admin-usage-expensive-conversations', adminUsageExpensiveConversations);
server.tool('admin-usage-timeline', adminUsageTimeline);
server.tool('admin-usage-sessions', adminUsageSessions);
server.tool('admin-usage-session-detail', adminUsageSessionDetail);

// ── LLM Health & Observability ──
server.tool('admin-model-health', adminModelHealth);
server.tool('admin-model-health-timeseries', adminModelHealthTimeseries);
server.tool('admin-upstream-errors', adminUpstreamErrors);
server.tool('admin-in-flight', adminInFlight);
server.tool('admin-provider-status', adminProviderStatus);

// ── Feature Flags ──
server.tool('admin-feature-flags-list', adminFeatureFlagsList);
server.tool('admin-feature-flags-get', adminFeatureFlagsGet);
server.tool('admin-feature-flags-update', adminFeatureFlagsUpdate);
server.tool('admin-feature-flags-reset-default', adminFeatureFlagsResetDefault);
server.tool('admin-feature-flags-get-overrides', adminFeatureFlagsGetOverrides);
server.tool('admin-feature-flags-set-override', adminFeatureFlagsSetOverride);
server.tool('admin-feature-flags-delete-override', adminFeatureFlagsDeleteOverride);

async function main() {
  console.error(`🔧 Teros Admin Panel MCA starting (appId: ${MCA_APP_ID}, name: ${MCA_APP_NAME})`);

  await initializeWsClient();

  if (isWsConnected()) {
    console.error('✅ Connected to backend via WebSocket');
  } else {
    console.error('⚠️ WebSocket connection failed — health check will report DEPENDENCY_UNAVAILABLE');
  }

  await server.start();
  console.error('🔗 Teros Admin Panel MCA running');
}

main().catch((error) => {
  console.error('[Teros Admin] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.error('👋 Shutting down Teros Admin...');
  disconnectWsClient();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('👋 Shutting down Teros Admin...');
  disconnectWsClient();
  process.exit(0);
});
