/**
 * IMcaService Interface
 *
 * Interface for MCA (Model Context App) service operations.
 * Manages catalog, app installations, and agent access.
 */

import type {
  AgentAppAccess,
  AgentApps,
  App,
  AppToolPermissions,
  McpCatalogEntry,
  ResolvedApp,
} from '../../types/database';
import type { McaExecutionConfig } from '../mca-service';

/**
 * Result of app name validation
 */
export interface AppNameValidation {
  valid: boolean;
  error?: string;
}

/**
 * Result of app operations that may fail
 */
export interface AppOperationResult {
  success: boolean;
  error?: string;
}

/**
 * Result of orphaned apps cleanup
 */
export interface OrphanedAppsResult {
  disabled: string[];
  reEnabled: string[];
}

/**
 * Interface for MCA Service
 */
export interface IMcaService {
  // ============================================================================
  // MCP CATALOG
  // ============================================================================

  /**
   * List all MCAs in catalog
   */
  listCatalog(status?: McpCatalogEntry['status']): Promise<McpCatalogEntry[]>;

  /**
   * Get MCA from catalog by ID
   */
  getMcaFromCatalog(mcaId: string): Promise<McpCatalogEntry | null>;

  // ============================================================================
  // APPS (Installed MCA instances)
  // ============================================================================

  /**
   * Get app by ID
   */
  getApp(appId: string): Promise<App | null>;

  /**
   * Get resolved app (with MCA catalog data)
   */
  getResolvedApp(appId: string): Promise<ResolvedApp | null>;

  /**
   * List apps by owner
   */
  listAppsByOwner(ownerId: string): Promise<App[]>;

  /**
   * Create a new app
   */
  createApp(app: Omit<App, 'createdAt' | 'updatedAt'>): Promise<App>;

  /**
   * Validate app name format
   */
  validateAppName(name: string): AppNameValidation;

  /**
   * Check if app name is available for owner
   */
  isAppNameAvailable(ownerId: string, name: string, excludeAppId?: string): Promise<boolean>;

  /**
   * Rename an app
   */
  renameApp(appId: string, ownerId: string, newName: string): Promise<AppOperationResult>;

  /**
   * Generate default app name from mcpId
   */
  generateDefaultAppName(mcaId: string, ownerId: string): Promise<string>;

  /**
   * Delete an app
   */
  deleteApp(appId: string, ownerId: string): Promise<AppOperationResult>;

  // ============================================================================
  // AGENT ACCESS
  // ============================================================================

  /**
   * Grant agent access to an app
   */
  grantAccess(access: Omit<AgentAppAccess, 'grantedAt'>): Promise<AgentAppAccess>;

  /**
   * Revoke agent access to an app
   */
  revokeAccess(agentId: string, appId: string): Promise<boolean>;

  /**
   * Check if agent has access to app
   */
  hasAccess(agentId: string, appId: string): Promise<boolean>;

  /**
   * Get agent access record
   */
  getAccess(agentId: string, appId: string): Promise<AgentAppAccess | null>;

  /**
   * Update tool permissions for agent's app access
   */
  updatePermissions(
    agentId: string,
    appId: string,
    permissions: AppToolPermissions,
  ): Promise<AgentAppAccess | null>;

  /**
   * Get all access records for an app
   */
  getAppAccessList(appId: string): Promise<AgentAppAccess[]>;

  // ============================================================================
  // AGENT APPS (Combined queries)
  // ============================================================================

  /**
   * Ensure system apps are provisioned for agent
   */
  ensureSystemApps(agentId: string): Promise<void>;

  /**
   * Disable orphaned apps and re-enable recovered ones
   */
  disableOrphanedApps(): Promise<OrphanedAppsResult>;

  /**
   * Delete apps whose mcaId no longer exists in the active catalog.
   * Also deletes all associated agent_app_access entries.
   */
  deleteOrphanedApps(
    activeMcaIds: Set<string>,
  ): Promise<{ deleted: Array<{ appId: string; mcaId: string; name: string }> }>;

  /**
   * Get all apps an agent has access to (with resolved MCA info)
   */
  getAgentApps(agentId: string): Promise<AgentApps>;
}
