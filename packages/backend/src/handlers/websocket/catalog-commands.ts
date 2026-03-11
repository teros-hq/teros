/**
 * Catalog Commands Handler
 *
 * Handles: list_catalog, list_models, list_agent_cores, update_agent_core, update_mca
 */

import type { WebSocket } from 'ws';
import type { CatalogCommandsDeps } from './types';

export function createCatalogCommands(deps: CatalogCommandsDeps) {
  const { mcaService, modelService, buildAvatarUrl, sendMessage, sendError } = deps;

  return {
    /**
     * Handle list_catalog request - list available MCAs to install
     */
    async handleListCatalog(ws: WebSocket, userId: string, userRole: string): Promise<void> {
      try {
        const catalog = await mcaService.listCatalog('active');

        // Helper: Check if user has required role
        const hasRequiredRole = (requiredRole: string): boolean => {
          const roleHierarchy = { user: 0, admin: 1, super: 2 };
          const userLevel = roleHierarchy[userRole as keyof typeof roleHierarchy] ?? 0;
          const requiredLevel = roleHierarchy[requiredRole as keyof typeof roleHierarchy] ?? 0;
          return userLevel >= requiredLevel;
        };

        // Filter by availability.enabled, not hidden, and user role
        const availableMcas = catalog
          .filter((mca) => {
            if (mca.availability?.enabled === false) return false;
            if (mca.availability?.hidden === true) return false;

            const requiredRole = mca.availability?.role || 'user';
            if (!hasRequiredRole(requiredRole)) return false;

            return true;
          })
          .map((mca) => ({
            mcaId: mca.mcaId,
            name: mca.name,
            description: mca.description,
            icon: mca.icon,
            color: mca.color,
            category: mca.category,
            tools: mca.tools,
            availability: {
              enabled: mca.availability?.enabled ?? true,
              multi: mca.availability?.multi ?? false,
              system: mca.availability?.system ?? false,
              hidden: mca.availability?.hidden ?? false,
              role: mca.availability?.role ?? 'user',
            },
          }));

        sendMessage(ws, {
          type: 'catalog_list',
          catalog: availableMcas,
        } as any);
      } catch (error) {
        console.error('❌ Error listing catalog:', error);
        sendError(ws, 'LIST_CATALOG_ERROR', 'Failed to list catalog');
      }
    },

    /**
     * Handle list_all_mcas request - list ALL MCAs (admin, no filters)
     */
    async handleListAllMcas(ws: WebSocket): Promise<void> {
      try {
        const catalog = await mcaService.listCatalog(); // No status filter

        // Return all MCAs with full data
        const allMcas = catalog.map((mca) => ({
          mcaId: mca.mcaId,
          name: mca.name,
          description: mca.description,
          icon: mca.icon,
          color: mca.color,
          category: mca.category,
          tools: mca.tools,
          status: mca.status,
          availability: {
            enabled: mca.availability?.enabled ?? true,
            multi: mca.availability?.multi ?? false,
            system: mca.availability?.system ?? false,
            hidden: mca.availability?.hidden ?? false,
            role: mca.availability?.role ?? 'user',
          },
          systemSecrets: mca.systemSecrets || [],
          userSecrets: mca.userSecrets || [],
          auth: mca.auth,
        }));

        sendMessage(ws, {
          type: 'all_mcas_list',
          mcas: allMcas,
        } as any);
      } catch (error) {
        console.error('❌ Error listing all MCAs:', error);
        sendError(ws, 'LIST_ALL_MCAS_ERROR', 'Failed to list all MCAs');
      }
    },

    /**
     * Handle list_models request - list available models
     */
    async handleListModels(ws: WebSocket): Promise<void> {
      try {
        const models = await modelService.listModels('active');

        sendMessage(ws, {
          type: 'models_list',
          models: models.map((m) => ({
            modelId: m.modelId,
            name: m.name,
            provider: m.provider,
            description: m.description,
            modelString: m.modelString,
            context: m.context,
            defaults: m.defaults,
            capabilities: m.capabilities,
            status: m.status,
          })),
        } as any);
      } catch (error) {
        console.error('❌ Error listing models:', error);
        sendError(ws, 'LIST_MODELS_ERROR', 'Failed to list models');
      }
    },

    /**
     * Handle list_agent_cores request - list all agent cores
     */
    async handleListAgentCores(ws: WebSocket, message: any): Promise<void> {
      try {
        const status = message.status as 'active' | 'inactive' | undefined;
        const cores = await modelService.listAgentCores(status);

        sendMessage(ws, {
          type: 'agent_cores_list',
          cores: cores.map((c) => ({
            coreId: c.coreId,
            name: c.name,
            fullName: c.fullName,
            version: c.version,
            systemPrompt: c.systemPrompt,
            personality: c.personality,
            capabilities: c.capabilities,
            avatarUrl: buildAvatarUrl(c.avatarUrl),
            modelId: c.modelId,
            modelOverrides: c.modelOverrides,
            status: c.status,
          })),
        } as any);
      } catch (error) {
        console.error('❌ Error listing agent cores:', error);
        sendError(ws, 'LIST_AGENT_CORES_ERROR', 'Failed to list agent cores');
      }
    },

    /**
     * Handle update_agent_core request - update an agent core configuration
     */
    async handleUpdateAgentCore(ws: WebSocket, message: any): Promise<void> {
      try {
        const { coreId, updates } = message;

        const updatedCore = await modelService.updateAgentCore(coreId, updates);

        if (!updatedCore) {
          sendError(ws, 'AGENT_CORE_NOT_FOUND', `Agent core ${coreId} not found`);
          return;
        }

        sendMessage(ws, {
          type: 'agent_core_updated',
          core: {
            coreId: updatedCore.coreId,
            name: updatedCore.name,
            fullName: updatedCore.fullName,
            version: updatedCore.version,
            systemPrompt: updatedCore.systemPrompt,
            personality: updatedCore.personality,
            capabilities: updatedCore.capabilities,
            avatarUrl: buildAvatarUrl(updatedCore.avatarUrl),
            modelId: updatedCore.modelId,
            modelOverrides: updatedCore.modelOverrides,
            status: updatedCore.status,
          },
        } as any);

        console.log(`✅ Updated agent core ${coreId}`);
      } catch (error) {
        console.error('❌ Error updating agent core:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to update agent core';
        sendError(ws, 'UPDATE_AGENT_CORE_ERROR', errorMessage);
      }
    },

    /**
     * Handle update_mca request - update MCA availability settings
     */
    async handleUpdateMca(ws: WebSocket, message: any): Promise<void> {
      try {
        const { mcpId, updates } = message;

        if (!mcpId) {
          sendError(ws, 'INVALID_REQUEST', 'mcpId is required');
          return;
        }

        const updatedMca = await mcaService.updateMcaAvailability(mcpId, updates);

        if (!updatedMca) {
          sendError(ws, 'MCA_NOT_FOUND', `MCA ${mcpId} not found`);
          return;
        }

        sendMessage(ws, {
          type: 'mca_updated',
          mca: {
            mcaId: updatedMca.mcaId,
            name: updatedMca.name,
            description: updatedMca.description,
            icon: updatedMca.icon,
            color: updatedMca.color,
            category: updatedMca.category,
            tools: updatedMca.tools,
            status: updatedMca.status,
            availability: {
              enabled: updatedMca.availability?.enabled ?? true,
              multi: updatedMca.availability?.multi ?? false,
              system: updatedMca.availability?.system ?? false,
              hidden: updatedMca.availability?.hidden ?? false,
              role: updatedMca.availability?.role ?? 'user',
            },
            systemSecrets: updatedMca.systemSecrets || [],
            userSecrets: updatedMca.userSecrets || [],
            auth: updatedMca.auth,
          },
        } as any);

        console.log(`✅ Updated MCA ${mcpId} availability`);
      } catch (error) {
        console.error('❌ Error updating MCA:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to update MCA';
        sendError(ws, 'UPDATE_MCA_ERROR', errorMessage);
      }
    },
  };
}
