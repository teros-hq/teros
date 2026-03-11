/**
 * App Auth Commands Handler
 *
 * Handles: get_app_auth_status, configure_app_credentials, disconnect_app_auth
 */

import type { AppAuthInfo } from '@teros/core';
import type { WebSocket } from 'ws';
import type { AppAuthCommandsDeps } from './types';

export function createAppAuthCommands(deps: AppAuthCommandsDeps) {
  const { mcaService, mcaOAuth, sendMessage, sendError } = deps;

  return {
    /**
     * Handle get_app_auth_status request - get auth status for an app
     */
    async handleGetAppAuthStatus(
      ws: WebSocket,
      userId: string,
      message: { appId: string },
    ): Promise<void> {
      const { appId } = message;
      console.log(
        `[handleGetAppAuthStatus] Getting auth status for app: ${appId}, user: ${userId}`,
      );

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!mcaOAuth) {
        console.log('[handleGetAppAuthStatus] mcaOAuth not configured');
        sendError(ws, 'AUTH_NOT_CONFIGURED', 'MCA OAuth not configured');
        return;
      }

      try {
        // Get app and MCA info
        const app = await mcaService.getApp(appId);
        if (!app) {
          console.log(`[handleGetAppAuthStatus] App ${appId} not found`);
          sendError(ws, 'APP_NOT_FOUND', `App ${appId} not found`);
          return;
        }
        console.log(`[handleGetAppAuthStatus] Found app: ${app.mcaId}`);

        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        if (!mca) {
          console.log(`[handleGetAppAuthStatus] MCA ${app.mcaId} not found in catalog`);
          sendError(ws, 'MCA_NOT_FOUND', `MCA ${app.mcaId} not found`);
          return;
        }
        console.log(`[handleGetAppAuthStatus] Found MCA: ${mca.name}`);

        // Get auth status
        const authStatus = await mcaOAuth.getAuthStatus(userId, appId, mca);
        console.log(`[handleGetAppAuthStatus] Auth status for ${appId}: ${authStatus.status}`);

        sendMessage(ws, {
          type: 'app_auth_status',
          appId,
          auth: authStatus,
        } as any);
        console.log(`[handleGetAppAuthStatus] Sent auth status response for ${appId}`);
      } catch (error) {
        console.error('❌ Error getting app auth status:', error);
        sendError(ws, 'GET_AUTH_STATUS_ERROR', 'Failed to get auth status');
      }
    },

    /**
     * Handle configure_app_credentials request - save API key credentials
     */
    async handleConfigureAppCredentials(
      ws: WebSocket,
      userId: string,
      message: { appId: string; credentials: Record<string, string> },
    ): Promise<void> {
      const { appId, credentials } = message;

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!credentials || Object.keys(credentials).length === 0) {
        sendError(ws, 'MISSING_CREDENTIALS', 'credentials are required');
        return;
      }

      if (!mcaOAuth) {
        sendError(ws, 'AUTH_NOT_CONFIGURED', 'MCA OAuth not configured');
        return;
      }

      try {
        // Get app info
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', `App ${appId} not found`);
          return;
        }

        // Save credentials
        await mcaOAuth.saveApiKeyCredentials(userId, appId, app.mcaId, credentials);

        // Get updated auth status
        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        const authStatus = mca
          ? await mcaOAuth.getAuthStatus(userId, appId, mca)
          : { status: 'ready' as const, authType: 'apikey' as const };

        sendMessage(ws, {
          type: 'app_credentials_configured',
          appId,
          success: true,
          auth: authStatus,
        } as any);

        console.log(`✅ Configured credentials for app ${appId} user ${userId}`);
      } catch (error) {
        console.error('❌ Error configuring app credentials:', error);
        sendError(ws, 'CONFIGURE_CREDENTIALS_ERROR', 'Failed to configure credentials');
      }
    },

    /**
     * Handle disconnect_app_auth request - revoke OAuth credentials
     */
    async handleDisconnectAppAuth(
      ws: WebSocket,
      userId: string,
      message: { appId: string },
    ): Promise<void> {
      const { appId } = message;

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!mcaOAuth) {
        sendError(ws, 'AUTH_NOT_CONFIGURED', 'MCA OAuth not configured');
        return;
      }

      try {
        // Disconnect
        await mcaOAuth.disconnect(userId, appId);

        // Get updated auth status
        const app = await mcaService.getApp(appId);
        let authStatus: AppAuthInfo = { status: 'needs_user_auth', authType: 'none' };

        if (app) {
          const mca = await mcaService.getMcaFromCatalog(app.mcaId);
          if (mca) {
            authStatus = await mcaOAuth.getAuthStatus(userId, appId, mca);
          }
        }

        sendMessage(ws, {
          type: 'app_auth_disconnected',
          appId,
          success: true,
          auth: authStatus,
        } as any);

        console.log(`✅ Disconnected auth for app ${appId} user ${userId}`);
      } catch (error) {
        console.error('❌ Error disconnecting app auth:', error);
        sendError(ws, 'DISCONNECT_AUTH_ERROR', 'Failed to disconnect auth');
      }
    },
  };
}
