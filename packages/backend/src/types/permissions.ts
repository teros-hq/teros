/**
 * Permission Utilities
 *
 * Helper functions for resolving tool permissions.
 *
 * Permissions are stored in the App entity (not AgentAppAccess).
 * Default permission for all tools is 'ask'.
 */

import type { McaToolAnnotations } from '@teros/shared';
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
 * Whether a tool is read-only (MCP `readOnlyHint`). Explicit manifest
 * annotations ONLY — the name heuristic was removed 2026-07-04 after baking
 * explicit `readOnlyHint` into every MCA. No annotation = mutation.
 */
export function isToolReadOnly(_toolName: string, annotations?: McaToolAnnotations): boolean {
  return annotations?.readOnlyHint === true;
}

/**
 * Whether a tool is confirmation-locked (`annotations.alwaysAsk`). Policy
 * flag, always explicit in the manifest.
 */
export function isToolAlwaysAsk(_toolName: string, annotations?: McaToolAnnotations): boolean {
  return annotations?.alwaysAsk === true;
}

/**
 * THE source of truth for "will this tool run without asking the user".
 *
 * The configured permission is pure data — seeded at install time by
 * `createInstallPermissions` (read-only → allow, mutation → ask) and from
 * then on owned entirely by the user. There is deliberately NO read-only
 * auto-allow policy here: if the user flips a read tool to `ask`, it asks.
 *
 * The single runtime override is the `alwaysAsk` clamp: a
 * confirmation-locked tool (`annotations.alwaysAsk`) NEVER runs without
 * asking — a configured `allow` is demoted to `ask`; only `forbid`
 * survives, being more restrictive. Forbidden-by-design auto-runs: app
 * self-installation, granting/setting agent permissions.
 *
 * Must be the only place that encodes this policy so the runtime gate
 * (`mca-tool-executor`) and the UI (`app.get-tools`, summaries) never diverge.
 */
export function getEffectiveToolPermission(
  app: App | { permissions?: AppToolPermissions },
  toolName: string,
  annotations?: McaToolAnnotations,
): ToolPermission {
  const configured = getToolPermission(app, toolName);
  if (configured !== 'forbid' && isToolAlwaysAsk(toolName, annotations)) {
    return 'ask';
  }
  return configured;
}

/**
 * Build the permissions-panel view for an app in ONE place so every handler
 * (get-tools + the mutation handlers) returns identical data:
 *   - `tools[].permission` = the **configured** value (drives the toggle).
 *     Since permissions are seeded explicitly at install time, this IS what
 *     runs — except for the `alwaysAsk` clamp below.
 *   - `tools[].readOnly`   = informational manifest flag (`readOnlyHint`).
 *     Drives the "solo lectura" badge.
 *   - `tools[].alwaysAsk`  = confirmation-locked by the manifest. The UI
 *     blocks selecting 'allow' (the runtime clamp would ignore it anyway).
 *   - `summary`            = counts of the **effective** permission (what
 *     actually happens), so the header matches runtime behaviour.
 *
 * `annotationsByName` is keyed by the kebab-normalised short tool name.
 */
export function buildToolPermissionsView(
  app: App | { permissions?: AppToolPermissions },
  toolNames: string[],
  annotationsByName: Map<string, McaToolAnnotations>,
): {
  tools: Array<{
    name: string;
    permission: ToolPermission;
    readOnly: boolean;
    alwaysAsk: boolean;
  }>;
  summary: { allow: number; ask: number; forbid: number };
} {
  const publicTools = toolNames.filter((name) => !isPrivateTool(name));
  const summary = { allow: 0, ask: 0, forbid: 0 };
  const tools = publicTools.map((name) => {
    const annotations = annotationsByName.get(normalizeToolName(name));
    const configured = getToolPermission(app, name);
    const effective = getEffectiveToolPermission(app, name, annotations);
    summary[effective]++;
    return {
      name,
      permission: configured,
      readOnly: isToolReadOnly(name, annotations),
      alwaysAsk: isToolAlwaysAsk(name, annotations),
    };
  });
  return { tools, summary };
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
 * Install-time permission for ONE tool — the exact criterion
 * `createInstallPermissions` applies per tool, extracted so the MCA-update
 * delta seed (`propagateToolsToApps`) and the install seed can never drift
 * apart. `allow` when the manifest marks the tool read-only OR a safe write
 * (and not confirmation-locked), `ask` otherwise.
 */
export function installSeedPermission(
  tool: { name: string; annotations?: McaToolAnnotations },
): ToolPermission {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const safeWrite = tool.annotations?.safeWriteHint === true;
  const locked = tool.annotations?.alwaysAsk === true;
  return readOnly || safeWrite ? (locked ? 'ask' : 'allow') : 'ask';
}

/**
 * Install-time permission seed: every public tool gets an EXPLICIT entry —
 * `allow` when the manifest marks it read-only OR a safe write (and not
 * confirmation-locked), `ask` otherwise. No runtime policy ever upgrades
 * these afterwards: what the user sees in the panel is exactly what runs,
 * and flipping a read-only tool back to `ask` sticks because it is just data.
 *
 * `safeWriteHint` (Teros policy hint) covers mutating tools whose write is
 * reversible, private and non-notifying — e.g. saving knowledge to the
 * memory base. It seeds 'allow' exactly like read-only; `alwaysAsk` still
 * wins when both are set.
 *
 * `defaultPermission` stays 'ask' so tools added by a later MCA update are
 * conservative until the user (or a re-seed) touches them.
 */
export function createInstallPermissions(
  tools: Array<{ name: string; annotations?: McaToolAnnotations }>,
): AppToolPermissions {
  const perms: Record<string, ToolPermission> = {};
  for (const tool of tools) {
    if (isPrivateTool(tool.name)) continue;
    perms[tool.name] = installSeedPermission(tool);
  }
  return {
    tools: perms,
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

// ============================================================================
// Teros Guard — verdict mapping (docs/specs/security/20261106_teros-guard.md)
// ============================================================================

/**
 * Verdict of a Teros Guard evaluation over an already-resolved `allow`.
 *
 * The guard is a cheap-LLM review layer BETWEEN permission resolution and
 * execution. It only ever DEGRADES an `allow` — never upgrades anything — so
 * it is not a fourth permission and does not touch the resolver (TER-369):
 * the configured `allow` stays the configured `allow`; what the guard adds is
 * an execution-time layer, visible as such when it acts.
 */
export type GuardVerdict = 'pass' | 'force_ask' | 'block';

/**
 * Map a guard verdict onto the effective permission for THIS call.
 *
 * Same family as `getEffectiveToolPermission`: the single place that encodes
 * how an extra policy layer degrades a permission, so the runtime gate
 * (`mca-tool-executor`) and any future UI never diverge.
 *
 * Rules (design §2.1 / §3):
 * - Non-`allow` permissions pass through untouched — the guard never upgrades.
 * - `pass`      → keep `allow` (no friction).
 * - `block`     → `forbid` (denied by the guard; the agent gets the reason).
 * - `force_ask` → `ask`; in headless mode with no observer channel there is
 *   no human to ask, so it collapses to `forbid` — the same honest auto-deny
 *   the ask branch already applies (TER-157). With an observer in the chain
 *   the ask surfaces in the parent via the dual-broadcast (TER-338).
 */
export function applyGuardVerdict(
  permission: ToolPermission,
  verdict: GuardVerdict,
  headless: boolean,
): ToolPermission {
  if (permission !== 'allow') return permission; // the guard never upgrades
  if (verdict === 'pass') return 'allow';
  if (verdict === 'block') return 'forbid';
  return headless ? 'forbid' : 'ask'; // force_ask
}
