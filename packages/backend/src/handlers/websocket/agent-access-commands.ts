/**
 * Agent Access Commands Handler
 *
 * Handles: get_agent_apps, grant_app_access, revoke_app_access
 */

import type { WebSocket } from 'ws';
import type { CommandDeps } from './types';

export function createAgentAccessCommands(deps: CommandDeps) {
  const { mcaService, sendMessage, sendError } = deps;

  return {
    /**
     * Handle get_agent_apps request - get apps an agent has access to
     */
    async handleGetAgentApps(ws: WebSocket, message: any): Promise<void> {
      try {
        const { agentId } = message;
        console.log(`[AgentAccess] handleGetAgentApps called for agent: ${agentId}`);

        // Get all apps the agent has access to
        const agentApps = await mcaService.getAgentApps(agentId);
        console.log(`[AgentAccess] Got ${agentApps.apps.length} apps for agent ${agentId}`);

        // Format response with app details
        const appsWithAccess = await Promise.all(
          agentApps.apps.map(async ({ app, access }) => ({
            appId: app.appId,
            name: app.name,
            mcaId: app.mca.mcaId,
            description: app.mca.description,
            icon: app.mca.icon,
            hasAccess: true,
            grantedAt: access.grantedAt,
          })),
        );

        sendMessage(ws, {
          type: 'agent_apps',
          agentId,
          apps: appsWithAccess,
        } as any);
      } catch (error) {
        console.error('❌ Error getting agent apps:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';
        console.error('❌ Stack:', errorStack);
        sendError(ws, 'GET_AGENT_APPS_ERROR', `Failed to get agent apps: ${errorMessage}`);
      }
    },

    /**
     * Handle grant_app_access request
     */
    async handleGrantAppAccess(ws: WebSocket, userId: string, message: any): Promise<void> {
      try {
        const { agentId, appId } = message;

        await mcaService.grantAccess({
          agentId,
          appId,
          grantedBy: userId,
        });

        sendMessage(ws, {
          type: 'app_access_granted',
          agentId,
          appId,
          success: true,
        } as any);

        console.log(`✅ Granted ${agentId} access to ${appId}`);
      } catch (error) {
        console.error('❌ Error granting app access:', error);
        sendError(ws, 'GRANT_ACCESS_ERROR', 'Failed to grant app access');
      }
    },

    /**
     * Handle revoke_app_access request
     */
    async handleRevokeAppAccess(ws: WebSocket, userId: string, message: any): Promise<void> {
      try {
        const { agentId, appId } = message;

        const success = await mcaService.revokeAccess(agentId, appId);

        sendMessage(ws, {
          type: 'app_access_revoked',
          agentId,
          appId,
          success,
        } as any);

        console.log(`✅ Revoked ${agentId} access to ${appId}`);
      } catch (error) {
        console.error('❌ Error revoking app access:', error);
        sendError(ws, 'REVOKE_ACCESS_ERROR', 'Failed to revoke app access');
      }
    },
  };
}
