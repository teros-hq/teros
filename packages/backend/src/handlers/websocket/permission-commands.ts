/**
 * Permission Commands Handler
 *
 * Handles WebSocket commands for tool permissions:
 * - tool_permission_response: User response to permission request (runtime)
 * - get_app_tools: Get tools list with permissions
 * - update_tool_permission: Update a single tool's permission
 * - set_all_tool_permissions: Set all tools to same permission
 *
 * Permissions are stored in App.permissions (not AgentAppAccess).
 * Default permission for all tools is 'ask'.
 */

import type { WebSocket } from 'ws';
import type { AppToolPermissions, ToolPermission } from '../../types/database';
import {
  getPermissionsSummary,
  getToolPermission,
  isPrivateTool,
  normalizeToolName,
} from '../../types/permissions';
import type { PermissionCommandsDeps } from './types';

export function createPermissionCommands(deps: PermissionCommandsDeps) {
  const { mcaService, handlePermissionResponse, sendMessage, sendError, workspaceService } = deps;

  /**
   * Check if user can manage an app's permissions
   * - User apps: user must be the owner
   * - Workspace apps: user must have admin access to the workspace
   * - System apps: no one can modify
   */
  async function canManageApp(
    app: { ownerId: string; ownerType?: string },
    userId: string,
  ): Promise<boolean> {
    // User-owned apps
    if (app.ownerId === userId) {
      return true;
    }

    // System apps - no one can modify permissions
    if (app.ownerId === 'system') {
      return false;
    }

    // Workspace apps - check if user has admin access
    if (app.ownerType === 'workspace' || app.ownerId.startsWith('work_')) {
      if (workspaceService) {
        return await workspaceService.canAdmin(app.ownerId, userId);
      }
      return false;
    }

    return false;
  }

  return {
    /**
     * Handle tool_permission_response - user response to permission request
     * This is for runtime permission requests, not configuration
     */
    async handleToolPermissionResponse(message: {
      requestId: string;
      granted: boolean;
    }): Promise<void> {
      const { requestId, granted } = message;

      if (!requestId) {
        console.warn('[PermissionCommands] tool_permission_response missing requestId');
        return;
      }

      console.log(
        `[PermissionCommands] Tool permission response: ${requestId} = ${granted ? 'granted' : 'denied'}`,
      );
      await handlePermissionResponse(requestId, granted);
    },

    /**
     * Handle get_app_tools - get tools list with permissions
     * Permissions come from App.permissions
     */
    async handleGetAppTools(
      ws: WebSocket,
      userId: string,
      message: { appId: string },
    ): Promise<void> {
      const { appId } = message;
      console.log(`[PermissionCommands] get_app_tools: appId=${appId}`);

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      try {
        // Get app
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', 'App not found');
          return;
        }

        // Check access (user apps, workspace apps with access, or system apps for reading)
        const canAccess =
          app.ownerId === userId ||
          app.ownerId === 'system' ||
          (workspaceService && (await workspaceService.canAccess(app.ownerId, userId)));
        if (!canAccess) {
          sendError(ws, 'ACCESS_DENIED', 'Access denied');
          return;
        }

        // Get MCA for tool list
        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        if (!mca) {
          sendError(ws, 'MCA_NOT_FOUND', 'MCA not found');
          return;
        }

        // Filter out private tools (those starting with '-')
        const publicTools = mca.tools.filter((name) => !isPrivateTool(name));

        // Build tool list with permissions (from App)
        const tools = publicTools.map((name) => ({
          name,
          permission: getToolPermission(app, name),
        }));

        const summary = getPermissionsSummary(app.permissions, publicTools);

        sendMessage(ws, {
          type: 'app_tools',
          appId,
          appName: app.name,
          mcaName: mca.name,
          defaultPermission: app.permissions?.defaultPermission || 'ask',
          tools,
          summary,
        } as any);

        console.log(`[PermissionCommands] Sent app_tools for ${appId}: ${tools.length} tools`);
      } catch (error) {
        console.error('❌ Error getting app tools:', error);
        sendError(ws, 'GET_APP_TOOLS_ERROR', 'Failed to get app tools');
      }
    },

    /**
     * Handle update_tool_permission - update a single tool's permission
     * Updates App.permissions directly
     */
    async handleUpdateToolPermission(
      ws: WebSocket,
      userId: string,
      message: { appId: string; toolName: string; permission: ToolPermission },
    ): Promise<void> {
      const { appId, toolName, permission } = message;
      console.log(
        `[PermissionCommands] update_tool_permission: appId=${appId}, tool=${toolName}, permission=${permission}`,
      );

      if (!appId || !toolName || !permission) {
        sendError(ws, 'MISSING_PARAMS', 'appId, toolName, and permission are required');
        return;
      }

      if (!['allow', 'ask', 'forbid'].includes(permission)) {
        sendError(ws, 'INVALID_PERMISSION', 'Permission must be: allow, ask, or forbid');
        return;
      }

      try {
        // Extract short tool name (e.g., "bash_bash" -> "bash", "filesystem_read" -> "read")
        const shortToolName = toolName.includes('_')
          ? toolName.split('_').slice(1).join('_')
          : toolName;

        // Get app
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', 'App not found');
          return;
        }

        // Check if user can manage this app's permissions
        if (!(await canManageApp(app, userId))) {
          sendError(
            ws,
            'ACCESS_DENIED',
            'Access denied - you need admin access to modify permissions',
          );
          return;
        }

        // Verify tool exists in MCA (using short name, normalized to kebab-case)
        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        if (!mca) {
          sendError(ws, 'MCA_NOT_FOUND', `MCA '${app.mcaId}' not found`);
          return;
        }
        const normalizedShortName = normalizeToolName(shortToolName);
        const normalizedTools = mca.tools.map(normalizeToolName);
        if (!normalizedTools.includes(normalizedShortName)) {
          sendError(ws, 'TOOL_NOT_FOUND', `Tool '${shortToolName}' not found in this app`);
          return;
        }

        // Update single tool permission in App (service also extracts short name)
        const updated = await mcaService.updateToolPermission(appId, toolName, permission);
        if (!updated) {
          sendError(ws, 'UPDATE_FAILED', 'Failed to update permission');
          return;
        }

        // Get updated summary
        const publicTools = mca.tools.filter((name) => !isPrivateTool(name));
        const summary = getPermissionsSummary(updated.permissions, publicTools);

        sendMessage(ws, {
          type: 'tool_permission_updated',
          success: true,
          appId,
          toolName,
          permission,
          summary,
        } as any);

        console.log(`[PermissionCommands] Updated tool permission: ${toolName} = ${permission}`);
      } catch (error) {
        console.error('❌ Error updating tool permission:', error);
        sendError(ws, 'UPDATE_TOOL_PERMISSION_ERROR', 'Failed to update tool permission');
      }
    },

    /**
     * Handle set_all_tool_permissions - set all tools to the same permission
     * Updates App.permissions directly
     */
    async handleSetAllToolPermissions(
      ws: WebSocket,
      userId: string,
      message: { appId: string; permission: ToolPermission },
    ): Promise<void> {
      const { appId, permission } = message;
      console.log(
        `[PermissionCommands] set_all_tool_permissions: appId=${appId}, permission=${permission}`,
      );

      if (!appId || !permission) {
        sendError(ws, 'MISSING_PARAMS', 'appId and permission are required');
        return;
      }

      if (!['allow', 'ask', 'forbid'].includes(permission)) {
        sendError(ws, 'INVALID_PERMISSION', 'Permission must be: allow, ask, or forbid');
        return;
      }

      try {
        // Get app
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', 'App not found');
          return;
        }

        // Check if user can manage this app's permissions
        if (!(await canManageApp(app, userId))) {
          sendError(
            ws,
            'ACCESS_DENIED',
            'Access denied - you need admin access to modify permissions',
          );
          return;
        }

        // Set all tool permissions
        const updated = await mcaService.setAllToolPermissions(appId, permission);
        if (!updated) {
          sendError(ws, 'UPDATE_FAILED', 'Failed to update permissions');
          return;
        }

        // Get summary
        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        const publicTools = (mca?.tools || []).filter((name) => !isPrivateTool(name));
        const summary = getPermissionsSummary(updated.permissions, publicTools);

        sendMessage(ws, {
          type: 'all_tool_permissions_updated',
          success: true,
          appId,
          permission,
          summary,
        } as any);

        console.log(`[PermissionCommands] Set all tools to ${permission} for ${appId}`);
      } catch (error) {
        console.error('❌ Error setting all tool permissions:', error);
        sendError(ws, 'SET_ALL_PERMISSIONS_ERROR', 'Failed to set all permissions');
      }
    },

    /**
     * @deprecated Use update_tool_permission or set_all_tool_permissions instead
     * Handle update_app_permissions - update all permissions for an app
     */
    async handleUpdateAppPermissions(
      ws: WebSocket,
      userId: string,
      message: {
        appId: string;
        permissions: { defaultPermission: ToolPermission; tools?: Record<string, ToolPermission> };
      },
    ): Promise<void> {
      const { appId, permissions: rawPermissions } = message;
      console.log(`[PermissionCommands] update_app_permissions: appId=${appId}`);

      // Normalize permissions
      const permissions: AppToolPermissions = {
        defaultPermission: rawPermissions.defaultPermission,
        tools: rawPermissions.tools || {},
      };

      if (!appId || !rawPermissions) {
        sendError(ws, 'MISSING_PARAMS', 'appId and permissions are required');
        return;
      }

      try {
        // Validate permissions structure
        if (
          !rawPermissions.defaultPermission ||
          !['allow', 'ask', 'forbid'].includes(rawPermissions.defaultPermission)
        ) {
          sendError(ws, 'INVALID_PERMISSIONS', 'Invalid defaultPermission');
          return;
        }

        // Get app
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', 'App not found');
          return;
        }

        // Check if user can manage this app's permissions
        if (!(await canManageApp(app, userId))) {
          sendError(
            ws,
            'ACCESS_DENIED',
            'Access denied - you need admin access to modify permissions',
          );
          return;
        }

        // Update permissions in App
        const updated = await mcaService.updateAppPermissions(appId, permissions);
        if (!updated) {
          sendError(ws, 'UPDATE_FAILED', 'Failed to update permissions');
          return;
        }

        // Get MCA for summary
        const mca = await mcaService.getMcaFromCatalog(app.mcaId);
        const publicTools = (mca?.tools || []).filter((name) => !isPrivateTool(name));
        const summary = getPermissionsSummary(permissions, publicTools);

        sendMessage(ws, {
          type: 'app_permissions_updated',
          success: true,
          appId,
          permissions: updated.permissions,
          summary,
        } as any);

        console.log(`[PermissionCommands] Updated permissions for ${appId}`);
      } catch (error) {
        console.error('❌ Error updating app permissions:', error);
        sendError(ws, 'UPDATE_PERMISSIONS_ERROR', 'Failed to update permissions');
      }
    },
  };
}
