/**
 * App Commands Handler
 *
 * Handles: list_apps, install_app, uninstall_app, rename_app
 */

import { generateAppId } from '@teros/core';
import type { WebSocket } from 'ws';
import type { AppCommandsDeps } from './types';

export function createAppCommands(deps: AppCommandsDeps) {
  const { mcaService, sendMessage, sendError } = deps;

  return {
    /**
     * Handle list_apps request
     */
    async handleListApps(ws: WebSocket, userId: string): Promise<void> {
      try {
        // Get user's apps and system apps
        const [userApps, systemApps] = await Promise.all([
          mcaService.listAppsByOwner(userId),
          mcaService.listAppsByOwner('system'),
        ]);

        // Combine both, user apps first
        const allApps = [...userApps, ...systemApps];

        // Get MCP info for each app
        const appsWithInfo = await Promise.all(
          allApps.map(async (app) => {
            const mcp = await mcaService.getMcaFromCatalog(app.mcaId);
            return {
              appId: app.appId,
              name: app.name,
              mcaId: app.mcaId,
              mcpName: mcp?.name || app.mcaId,
              description: mcp?.description || '',
              icon: mcp?.icon,
              color: mcp?.color,
              category: mcp?.category || 'integration',
              status: app.status,
            };
          }),
        );

        sendMessage(ws, {
          type: 'apps_list',
          apps: appsWithInfo,
        } as any);
      } catch (error) {
        console.error('❌ Error listing apps:', error);
        sendError(ws, 'LIST_APPS_ERROR', 'Failed to list apps');
      }
    },

    /**
     * Handle install_app request - create an app from catalog MCA
     */
    async handleInstallApp(ws: WebSocket, userId: string, message: any): Promise<void> {
      try {
        const { mcaId, name } = message;

        // Verify MCA exists and is available
        const mca = await mcaService.getMcaFromCatalog(mcaId);
        if (!mca) {
          sendError(ws, 'MCA_NOT_FOUND', `MCA ${mcaId} not found in catalog`);
          return;
        }

        if (mca.availability?.enabled === false) {
          sendError(ws, 'MCA_DISABLED', `MCA ${mcaId} is not available`);
          return;
        }

        // Check role requirements
        const requiredRole = mca.availability?.role || 'user';
        if (requiredRole !== 'user') {
          // Get user's role from database
          const user = await mcaService.getUserRole(userId);
          if (!user) {
            sendError(ws, 'USER_NOT_FOUND', 'User not found');
            return;
          }

          const userRole = user.role || 'user';
          const roleHierarchy = { user: 0, admin: 1, super: 2 };
          const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] ?? 0;
          const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] ?? 0;

          if (userLevel < requiredLevel) {
            sendError(
              ws,
              'INSUFFICIENT_ROLE',
              `This MCA requires ${requiredRole} role. You have ${userRole} role.`,
            );
            return;
          }
        }

        // Generate unique app ID
        const appId = generateAppId();

        // Validate or generate app name
        let appName: string;
        if (name) {
          // Validate user-provided name
          const validation = mcaService.validateAppName(name);
          if (!validation.valid) {
            sendError(ws, 'INVALID_APP_NAME', validation.error || 'Invalid app name');
            return;
          }
          const isAvailable = await mcaService.isAppNameAvailable(userId, name);
          if (!isAvailable) {
            sendError(ws, 'APP_NAME_TAKEN', `App name "${name}" is already in use`);
            return;
          }
          appName = name;
        } else {
          // Generate default name from mcaId (e.g., mca.teros.bash -> bash)
          appName = await mcaService.generateDefaultAppName(mcaId, userId);
        }

        // Create the app
        const app = await mcaService.createApp({
          appId,
          mcaId,
          ownerId: userId,
          name: appName,
          status: 'active',
        });

        sendMessage(ws, {
          type: 'app_installed',
          app: {
            appId: app.appId,
            mcaId: app.mcaId,
            name: app.name,
            description: mca.description,
            icon: mca.icon,
            category: mca.category,
            status: app.status,
          },
        } as any);

        console.log(`✅ Installed app ${app.appId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error installing app:', error);
        sendError(ws, 'INSTALL_APP_ERROR', 'Failed to install app');
      }
    },

    /**
     * Handle uninstall_app request - uninstall an app
     */
    async handleUninstallApp(
      ws: WebSocket,
      userId: string,
      message: { appId: string },
    ): Promise<void> {
      const { appId } = message;

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      try {
        const result = await mcaService.deleteApp(appId, userId);

        if (!result.success) {
          sendError(ws, 'UNINSTALL_APP_ERROR', result.error || 'Failed to uninstall app');
          return;
        }

        sendMessage(ws, {
          type: 'app_uninstalled',
          appId,
        } as any);

        console.log(`✅ Uninstalled app ${appId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error uninstalling app:', error);
        sendError(ws, 'UNINSTALL_APP_ERROR', 'Failed to uninstall app');
      }
    },

    /**
     * Handle rename_app request - rename an installed app
     */
    async handleRenameApp(
      ws: WebSocket,
      userId: string,
      message: { appId: string; name: string; context?: string },
    ): Promise<void> {
      const { appId, name, context } = message;

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!name) {
        sendError(ws, 'MISSING_NAME', 'name is required');
        return;
      }

      try {
        const result = await mcaService.renameApp(appId, userId, name);

        if (!result.success) {
          sendError(ws, 'RENAME_APP_ERROR', result.error || 'Failed to rename app');
          return;
        }

        // Update context if provided
        if (context !== undefined) {
          const contextResult = await mcaService.updateAppContext(appId, userId, context);
          if (!contextResult.success) {
            console.error('❌ Failed to update app context:', contextResult.error);
            sendError(
              ws,
              'UPDATE_APP_CONTEXT_ERROR',
              contextResult.error || 'Failed to update app context',
            );
            return;
          }
        }

        sendMessage(ws, {
          type: 'app_renamed',
          appId,
          name,
          context: context !== undefined ? context : undefined,
        } as any);

        console.log(`✅ Renamed app ${appId} to "${name}" for user ${userId}`);
      } catch (error) {
        console.error('❌ Error renaming app:', error);
        sendError(ws, 'RENAME_APP_ERROR', 'Failed to rename app');
      }
    },
  };
}
