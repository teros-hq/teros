/**
 * Workspace Commands Handler
 *
 * Handles: list_workspaces, create_workspace, get_workspace, update_workspace,
 *          archive_workspace, list_workspace_apps, install_workspace_app
 */

import type { ServerMessage } from '@teros/shared';
import type { WebSocket } from 'ws';
import type { McaService } from '../../services/mca-service';
import type { WorkspaceService } from '../../services/workspace-service';

export interface WorkspaceCommandsDeps {
  workspaceService: WorkspaceService;
  mcaService: McaService;
  sendMessage: (ws: WebSocket, msg: ServerMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
}

export function createWorkspaceCommands(deps: WorkspaceCommandsDeps) {
  const { workspaceService, mcaService, sendMessage, sendError } = deps;

  return {
    /**
     * Handle list_workspaces request
     */
    async handleListWorkspaces(ws: WebSocket, userId: string): Promise<void> {
      try {
        const workspaces = await workspaceService.listUserWorkspaces(userId);

        // Add role info for each workspace
        const workspacesWithRole = await Promise.all(
          workspaces.map(async (workspace) => {
            const role = await workspaceService.getUserRole(workspace.workspaceId, userId);
            return {
              workspaceId: workspace.workspaceId,
              name: workspace.name,
              description: workspace.description,
              context: workspace.context,
              volumeId: workspace.volumeId,
              appearance: workspace.appearance,
              role,
              status: workspace.status,
              createdAt: workspace.createdAt,
            };
          }),
        );

        sendMessage(ws, {
          type: 'workspaces_list',
          workspaces: workspacesWithRole,
        } as any);
      } catch (error) {
        console.error('❌ Error listing workspaces:', error);
        sendError(ws, 'LIST_WORKSPACES_ERROR', 'Failed to list workspaces');
      }
    },

    /**
     * Handle create_workspace request
     */
    async handleCreateWorkspace(
      ws: WebSocket,
      userId: string,
      message: { name: string; description?: string },
    ): Promise<void> {
      try {
        const { name, description } = message;

        if (!name) {
          sendError(ws, 'MISSING_NAME', 'name is required');
          return;
        }

        const workspace = await workspaceService.createWorkspace(userId, {
          name,
          description,
        });

        sendMessage(ws, {
          type: 'workspace_created',
          workspace: {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            description: workspace.description,
            volumeId: workspace.volumeId,
            role: 'owner',
            status: workspace.status,
            createdAt: workspace.createdAt,
          },
        } as any);

        console.log(`✅ Created workspace ${workspace.workspaceId} for user ${userId}`);
      } catch (error) {
        console.error('❌ Error creating workspace:', error);
        sendError(ws, 'CREATE_WORKSPACE_ERROR', 'Failed to create workspace');
      }
    },

    /**
     * Handle get_workspace request
     */
    async handleGetWorkspace(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string },
    ): Promise<void> {
      try {
        const { workspaceId } = message;

        if (!workspaceId) {
          sendError(ws, 'MISSING_WORKSPACE_ID', 'workspaceId is required');
          return;
        }

        // Check access
        if (!(await workspaceService.canAccess(workspaceId, userId))) {
          sendError(ws, 'ACCESS_DENIED', 'You do not have access to this workspace');
          return;
        }

        const workspace = await workspaceService.getWorkspace(workspaceId);
        if (!workspace) {
          sendError(ws, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
          return;
        }

        const role = await workspaceService.getUserRole(workspaceId, userId);

        sendMessage(ws, {
          type: 'workspace_details',
          workspace: {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            description: workspace.description,
            context: workspace.context,
            volumeId: workspace.volumeId,
            ownerId: workspace.ownerId,
            members: workspace.members,
            settings: workspace.settings,
            appearance: workspace.appearance,
            role,
            status: workspace.status,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          },
        } as any);
      } catch (error) {
        console.error('❌ Error getting workspace:', error);
        sendError(ws, 'GET_WORKSPACE_ERROR', 'Failed to get workspace');
      }
    },

    /**
     * Handle update_workspace request
     */
    async handleUpdateWorkspace(
      ws: WebSocket,
      userId: string,
      message: {
        workspaceId: string;
        name?: string;
        description?: string;
        context?: string;
        appearance?: { color?: string; icon?: string };
      },
    ): Promise<void> {
      try {
        const { workspaceId, name, description, context, appearance } = message;

        if (!workspaceId) {
          sendError(ws, 'MISSING_WORKSPACE_ID', 'workspaceId is required');
          return;
        }

        const workspace = await workspaceService.updateWorkspace(workspaceId, userId, {
          name,
          description,
          context,
          appearance,
        });

        if (!workspace) {
          sendError(ws, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
          return;
        }

        sendMessage(ws, {
          type: 'workspace_updated',
          workspace: {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            description: workspace.description,
            context: workspace.context,
            appearance: workspace.appearance,
          },
        } as any);

        console.log(`✅ Updated workspace ${workspaceId}`);
      } catch (error: any) {
        console.error('❌ Error updating workspace:', error);
        if (error.message?.includes('Permission denied')) {
          sendError(ws, 'PERMISSION_DENIED', error.message);
        } else if (error.message?.includes('Invalid workspace')) {
          sendError(ws, 'INVALID_INPUT', error.message);
        } else {
          sendError(ws, 'UPDATE_WORKSPACE_ERROR', 'Failed to update workspace');
        }
      }
    },

    /**
     * Handle archive_workspace request
     */
    async handleArchiveWorkspace(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string },
    ): Promise<void> {
      try {
        const { workspaceId } = message;

        if (!workspaceId) {
          sendError(ws, 'MISSING_WORKSPACE_ID', 'workspaceId is required');
          return;
        }

        const success = await workspaceService.archiveWorkspace(workspaceId, userId);

        if (!success) {
          sendError(ws, 'WORKSPACE_NOT_FOUND', 'Workspace not found');
          return;
        }

        sendMessage(ws, {
          type: 'workspace_archived',
          workspaceId,
        } as any);

        console.log(`✅ Archived workspace ${workspaceId}`);
      } catch (error: any) {
        console.error('❌ Error archiving workspace:', error);
        if (error.message?.includes('Permission denied')) {
          sendError(ws, 'PERMISSION_DENIED', error.message);
        } else {
          sendError(ws, 'ARCHIVE_WORKSPACE_ERROR', 'Failed to archive workspace');
        }
      }
    },

    /**
     * Handle list_workspace_apps request
     */
    async handleListWorkspaceApps(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string },
    ): Promise<void> {
      try {
        const { workspaceId } = message;

        if (!workspaceId) {
          sendError(ws, 'MISSING_WORKSPACE_ID', 'workspaceId is required');
          return;
        }

        // Check access
        if (!(await workspaceService.canAccess(workspaceId, userId))) {
          sendError(ws, 'ACCESS_DENIED', 'You do not have access to this workspace');
          return;
        }

        const apps = await mcaService.listWorkspaceApps(workspaceId);

        // Enrich with MCA info
        const appsWithInfo = await Promise.all(
          apps.map(async (app) => {
            const mca = await mcaService.getMcaFromCatalog(app.mcaId);
            return {
              appId: app.appId,
              name: app.name,
              mcaId: app.mcaId,
              mcaName: mca?.name || app.mcaId,
              description: mca?.description || '',
              icon: mca?.icon,
              color: mca?.color,
              category: mca?.category || 'other',
              status: app.status,
              volumes: app.volumes,
            };
          }),
        );

        sendMessage(ws, {
          type: 'workspace_apps_list',
          workspaceId,
          apps: appsWithInfo,
        } as any);
      } catch (error) {
        console.error('❌ Error listing workspace apps:', error);
        sendError(ws, 'LIST_WORKSPACE_APPS_ERROR', 'Failed to list workspace apps');
      }
    },

    /**
     * Handle install_workspace_app request
     */
    async handleInstallWorkspaceApp(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string; mcaId: string; name?: string; mountPath?: string },
    ): Promise<void> {
      try {
        const { workspaceId, mcaId, name, mountPath } = message;

        if (!workspaceId) {
          sendError(ws, 'MISSING_WORKSPACE_ID', 'workspaceId is required');
          return;
        }

        if (!mcaId) {
          sendError(ws, 'MISSING_MCA_ID', 'mcaId is required');
          return;
        }

        const app = await mcaService.createWorkspaceApp(workspaceId, mcaId, name || '', userId, {
          mountPath,
        });

        const mca = await mcaService.getMcaFromCatalog(mcaId);

        sendMessage(ws, {
          type: 'workspace_app_installed',
          workspaceId,
          app: {
            appId: app.appId,
            name: app.name,
            mcaId: app.mcaId,
            mcaName: mca?.name || app.mcaId,
            description: mca?.description || '',
            icon: mca?.icon,
            category: mca?.category || 'other',
            status: app.status,
            volumes: app.volumes,
          },
        } as any);

        console.log(`✅ Installed app ${app.appId} in workspace ${workspaceId}`);
      } catch (error: any) {
        console.error('❌ Error installing workspace app:', error);
        if (error.message?.includes('Permission denied')) {
          sendError(ws, 'PERMISSION_DENIED', error.message);
        } else if (error.message?.includes('not found')) {
          sendError(ws, 'NOT_FOUND', error.message);
        } else {
          sendError(ws, 'INSTALL_WORKSPACE_APP_ERROR', 'Failed to install app in workspace');
        }
      }
    },
  };
}
