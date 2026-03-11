/**
 * Permission Utilities
 *
 * Helper functions for resolving tool permissions.
 *
 * Permissions are stored in the App entity (not AgentAppAccess).
 * Default permission for all tools is 'ask'.
 */

import type { App, AppToolPermissions, ToolPermission } from './database';

/**
 * Default permission when no permissions are configured
 */
export const DEFAULT_TOOL_PERMISSION: ToolPermission = 'ask';

/**
 * Normalize a tool name to kebab-case
 * Converts underscores to hyphens for consistent comparison
 *
 * @example normalizeToolName('list_recurring_tasks') -> 'list-recurring-tasks'
 * @example normalizeToolName('list-recurring-tasks') -> 'list-recurring-tasks'
 */
export function normalizeToolName(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

/**
 * Check if a tool is private (internal tool not shown in permissions UI)
 * Private tools start with '-' (e.g., '-health-check')
 */
export function isPrivateTool(toolName: string): boolean {
  return toolName.startsWith('-');
}

/**
 * Get the effective permission for a specific tool
 *
 * Resolution order:
 * 1. Private tools (starting with '-') are always 'allow'
 * 2. If permissions.tools[toolName] exists, use it
 * 3. If permissions.defaultPermission exists, use it
 * 4. Fall back to default permission ('ask')
 *
 * @param app - The app containing permissions
 * @param toolName - The name of the tool to check
 * @returns The effective permission for the tool
 */
export function getToolPermission(
  app: App | { permissions?: AppToolPermissions },
  toolName: string,
): ToolPermission {
  // Extract short tool name (e.g., "filesystem_read" -> "read")
  const shortName = toolName.includes('_') ? toolName.split('_').slice(1).join('_') : toolName;

  // Private tools are always allowed (e.g., -health-check)
  if (isPrivateTool(shortName)) {
    return 'allow';
  }

  // No permissions configured = all tools default to 'ask'
  if (!app.permissions) {
    return DEFAULT_TOOL_PERMISSION;
  }

  // Check for explicit tool permission (try short name first, then full name)
  const toolPermission = app.permissions.tools[shortName] ?? app.permissions.tools[toolName];
  if (toolPermission) {
    return toolPermission;
  }

  // Use default permission (or 'ask' if not set)
  return app.permissions.defaultPermission ?? DEFAULT_TOOL_PERMISSION;
}

/**
 * Check if a tool is allowed (can be used without confirmation)
 */
export function isToolAllowed(app: App, toolName: string): boolean {
  return getToolPermission(app, toolName) === 'allow';
}

/**
 * Check if a tool is forbidden (cannot be used at all)
 */
export function isToolForbidden(app: App, toolName: string): boolean {
  return getToolPermission(app, toolName) === 'forbid';
}

/**
 * Check if a tool requires confirmation
 */
export function isToolAskRequired(app: App, toolName: string): boolean {
  return getToolPermission(app, toolName) === 'ask';
}

/**
 * Create default permissions for an app (all tools set to 'ask')
 */
export function createDefaultPermissions(): AppToolPermissions {
  return {
    tools: {},
    defaultPermission: 'ask',
  };
}

/**
 * Create permissions with all tools set to a specific permission
 *
 * @param toolNames - List of tool names from the MCA
 * @param permission - Permission to set for all tools
 */
export function createUniformPermissions(
  toolNames: string[],
  permission: ToolPermission,
): AppToolPermissions {
  const tools: Record<string, ToolPermission> = {};
  for (const name of toolNames) {
    // Don't include private tools in permissions
    if (!isPrivateTool(name)) {
      tools[name] = permission;
    }
  }
  return {
    tools,
    defaultPermission: permission,
  };
}

/**
 * Update a single tool's permission
 */
export function setToolPermission(
  permissions: AppToolPermissions,
  toolName: string,
  permission: ToolPermission,
): AppToolPermissions {
  return {
    ...permissions,
    tools: {
      ...permissions.tools,
      [toolName]: permission,
    },
  };
}

/**
 * Set the default permission for tools not explicitly listed
 */
export function setDefaultPermission(
  permissions: AppToolPermissions,
  permission: ToolPermission,
): AppToolPermissions {
  return {
    ...permissions,
    defaultPermission: permission,
  };
}

/**
 * Get a summary of permissions for display
 * Excludes private tools from the count
 */
export function getPermissionsSummary(
  permissions: AppToolPermissions | undefined,
  toolNames: string[],
): { allow: number; ask: number; forbid: number } {
  const summary = { allow: 0, ask: 0, forbid: 0 };

  for (const toolName of toolNames) {
    // Skip private tools
    if (isPrivateTool(toolName)) continue;

    const permission =
      permissions?.tools[toolName] ?? permissions?.defaultPermission ?? DEFAULT_TOOL_PERMISSION;
    summary[permission]++;
  }

  return summary;
}
