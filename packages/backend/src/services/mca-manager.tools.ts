/**
 * MCA Manager — Tool management
 *
 * Static tool loading/caching, tool discovery, and tool execution
 * (both stdio and HTTP transports).
 */

import { McaToolAnnotationsSchema } from '@teros/shared';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { captureException } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import type { McaConnectionManager } from './mca-connection-manager';
import type { McaContainerManager } from './mca-container-manager';
import type { McaHttpClient } from './mca-http-client';
import type { McaService } from './mca-service';
import type {
  HealthCheckResult,
  ManagedMca,
  McaManagerConfig,
  StaticToolDefinition,
  ToolDefinition,
  ToolsJsonFile,
} from './mca-manager.types';
import { isHealthReady, truncateToolOutput } from './mca-manager.types';
import { normalizeToolName } from '../types/permissions';

const log = createLogger('McaManager');

/**
 * Context required by tool sub-functions.
 */
export interface ToolsContext {
  mcas: Map<string, ManagedMca>;
  mcaService: McaService;
  containerManager: McaContainerManager;
  httpClients: Map<string, McaHttpClient>;
  connectionManager?: McaConnectionManager;
  staticToolsCache: Map<string, StaticToolDefinition[]>;
  containerBackendHost: string;
  config: Required<Omit<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>> &
    Pick<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>;
  getOrSpawn(appId: string): Promise<ManagedMca>;
  registerApp(appId: string): Promise<ManagedMca | null>;
}

// ---------------------------------------------------------------------------
// Static tools cache
// ---------------------------------------------------------------------------

export function invalidateStaticToolsCache(ctx: ToolsContext, mcaId: string): void {
  if (ctx.staticToolsCache.has(mcaId)) {
    ctx.staticToolsCache.delete(mcaId);
    log.debug({ mcaId }, 'Invalidated static tools cache');
  }
  for (const [appId, managed] of ctx.mcas.entries()) {
    if (managed.mcaId === mcaId && managed.status === 'standby') {
      ctx.mcas.delete(appId);
      log.debug({ appId, mcaId }, 'Evicted standby entry');
    }
  }
}

export function loadStaticTools(ctx: ToolsContext, mcaId: string): StaticToolDefinition[] {
  if (ctx.staticToolsCache.has(mcaId)) {
    return ctx.staticToolsCache.get(mcaId)!;
  }
  const toolsPath = join(ctx.config.mcaBasePath, mcaId, 'tools.json');
  if (!existsSync(toolsPath)) {
    log.warn({ mcaId }, 'No tools.json found');
    return [];
  }
  try {
    const content = readFileSync(toolsPath, 'utf-8');
    const toolsFile: ToolsJsonFile = JSON.parse(content);

    // Validate `annotations` against the canonical Zod schema before
    // caching. A malformed annotation (e.g. `irreversible: "true"`
    // string instead of boolean) would otherwise propagate through the
    // executor unchanged and trigger a rogue irreversible badge in the
    // UI. We fail loud here — the manifest is rejected with an error
    // explicit enough for the MCA author to fix it. Tools without
    // `annotations` pass through untouched (the field is optional).
    for (const tool of toolsFile.tools) {
      if (tool.annotations === undefined) continue;
      const result = McaToolAnnotationsSchema.safeParse(tool.annotations);
      if (!result.success) {
        const err = new Error(
          `[McaManager] Invalid annotations in ${toolsPath} for tool "${tool.name}": ` +
            result.error.errors.map((e) => `${e.path.join('.')} ${e.message}`).join(', '),
        );
        log.error({ err, mcaId, toolName: tool.name }, err.message);
        captureException(err, {
          context: 'loadStaticTools.annotationsValidation',
          mcaId,
          toolName: tool.name,
          rawAnnotations: tool.annotations,
        });
        return [];
      }
      // Replace with the parsed object so consumers see fully-typed,
      // coerced values (Zod normalises e.g. `default()` fields).
      tool.annotations = result.data;
    }

    ctx.staticToolsCache.set(mcaId, toolsFile.tools);
    log.debug({ mcaId, count: toolsFile.tools.length }, 'Loaded static tools');
    return toolsFile.tools;
  } catch (error: any) {
    log.error({ err: error, mcaId }, 'Failed to load tools.json');
    return [];
  }
}

export function convertStaticTools(
  staticTools: StaticToolDefinition[],
  appName: string,
): { tools: ToolDefinition[]; mapping: Map<string, string> } {
  const tools: ToolDefinition[] = [];
  const mapping = new Map<string, string>();

  for (const tool of staticTools) {
    const originalName = tool.name;
    const kebabToolName = normalizeToolName(originalName);
    const sanitizedName = `${appName}_${kebabToolName}`;
    mapping.set(sanitizedName, originalName);

    if (originalName.startsWith('_')) continue;

    if (!tool.inputSchema || typeof tool.inputSchema.properties === 'undefined') {
      const err = new Error(
        '[McaManager] Broken tools.json: tool "' + originalName + '" in app "' + appName +
        '" is missing inputSchema.properties',
      );
      log.error({ err, inputSchema: tool.inputSchema }, err.message);
      captureException(err, { context: 'convertStaticTools', appName, toolName: originalName, inputSchema: tool.inputSchema });
      continue;
    }

    tools.push({
      name: sanitizedName,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.inputSchema.properties || {},
        required: tool.inputSchema.required,
      },
      // Propagate annotations end-to-end. Without this, the executor's
      // lookup `cachedTools.find(t => t.name === toolName).annotations`
      // is always undefined and `irreversible` never reaches the UI —
      // the cast in mca-tool-executor.ts hid this bug pre-fix.
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    });
  }

  return { tools, mapping };
}

// ---------------------------------------------------------------------------
// Tool lookup
// ---------------------------------------------------------------------------

export function getMcaIdForTool(ctx: ToolsContext, toolName: string): string | undefined {
  for (const mca of ctx.mcas.values()) {
    if (mca.toolNameMapping.has(toolName)) return mca.mcaId;
  }
  return undefined;
}

export async function getToolsForApp(
  ctx: ToolsContext,
  appId: string,
): Promise<{ tools: ToolDefinition[]; status: 'ready' | 'standby' | 'error' | 'disabled'; error?: string }> {
  const managed = ctx.mcas.get(appId);
  if (managed && managed.status === 'disabled') return { tools: [], status: 'disabled' };
  if (managed && managed.status === 'ready') return { tools: managed.tools, status: 'ready' };
  if (managed && managed.status === 'standby') return { tools: managed.tools, status: 'standby' };

  const app = await ctx.mcaService.getApp(appId);
  if (!app) return { tools: [], status: 'error', error: `App not found: ${appId}` };

  const staticTools = loadStaticTools(ctx, app.mcaId);
  if (staticTools.length === 0) {
    return { tools: [], status: 'error', error: managed?.lastError || `No tools.json found for ${app.mcaId}` };
  }
  const { tools } = convertStaticTools(staticTools, app.name);
  return { tools, status: 'standby', error: managed?.lastError };
}

// ---------------------------------------------------------------------------
// Health cache helper (also used by executeTool)
// ---------------------------------------------------------------------------

export function getCachedHealthIfNotReady(ctx: ToolsContext, appId: string): HealthCheckResult | null {
  const managed = ctx.mcas.get(appId);
  if (!managed || !managed.health) return null;
  if (isHealthReady(managed.health)) return null;
  return managed.health;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export async function executeTool(
  ctx: ToolsContext,
  toolName: string,
  input: Record<string, any>,
  context?: {
    agentId?: string;
    channelId?: string;
    appId?: string;
    userId?: string;
    workspaceId?: string;
    userDisplayName?: string;
    userAvatarUrl?: string;
    signal?: AbortSignal;
  },
): Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }> {
  let managed: ManagedMca | undefined;

  if (context?.appId) {
    managed = ctx.mcas.get(context.appId);
    if (!managed) {
      log.info({ appId: context.appId }, 'App not registered, attempting to register');
      try {
        managed = (await ctx.registerApp(context.appId)) ?? undefined;
      } catch {
        const appNamePrefix = toolName.split('_')[0];
        return {
          output: `Error: Cannot execute tool '${toolName}'. The app '${appNamePrefix}' is not installed or you don't have access to it.`,
          isError: true,
          mcaId: 'unknown',
        };
      }
      if (!managed) {
        const appNamePrefix = toolName.split('_')[0];
        return {
          output: `Error: Cannot execute tool '${toolName}'. The app '${appNamePrefix}' is not installed or you don't have access to it.`,
          isError: true,
          mcaId: 'unknown',
        };
      }
    }
  }

  if (!managed) {
    log.warn({ toolName }, 'executeTool called without appId - using fallback lookup');
    for (const mca of ctx.mcas.values()) {
      if (mca.toolNameMapping.has(toolName)) { managed = mca; break; }
    }
    if (!managed) {
      const appName = toolName.split('_')[0];
      for (const mca of ctx.mcas.values()) {
        if (mca.appName === appName) { managed = mca; break; }
      }
    }
  }

  if (!managed) {
    return {
      output: `Error: Tool '${toolName}' not found. The MCA may not be installed or configured.`,
      isError: true,
      mcaId: 'unknown',
    };
  }

  if (managed.status === 'disabled') {
    return {
      output: `Error: Tool '${toolName}' is disabled. The MCA has been disabled by the user.`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }

  const cachedHealth = getCachedHealthIfNotReady(ctx, managed.appId);
  if (cachedHealth) {
    log.debug({ appId: managed.appId }, 'MCA not ready, returning cached health error');
    return {
      output: JSON.stringify({
        error: 'MCA_NOT_READY',
        message: cachedHealth.message || 'MCA is not ready',
        status: cachedHealth.status,
        issues: cachedHealth.issues,
      }),
      isError: true,
      mcaId: managed.mcaId,
    };
  }

  if (managed.status !== 'ready') {
    log.debug({ appId: managed.appId }, 'MCA not ready, attempting to spawn');
    try {
      await ctx.getOrSpawn(managed.appId);
      managed = ctx.mcas.get(managed.appId);
      if (!managed || managed.status !== 'ready') {
        return {
          output: `Error: Failed to start MCA for tool '${toolName}'. ${managed?.lastError || 'Unknown error'}`,
          isError: true,
          mcaId: managed?.mcaId || 'unknown',
        };
      }
    } catch (error: any) {
      return {
        output: `Error: Cannot execute tool '${toolName}'. The MCA failed to start: ${error.message}`,
        isError: true,
        mcaId: managed?.mcaId || 'unknown',
      };
    }
  }

  if (!managed) {
    return { output: `Error: Internal error - MCA not found after spawn attempt`, isError: true, mcaId: 'unknown' };
  }

  const originalToolName = managed.toolNameMapping.get(toolName);
  if (!originalToolName) {
    return {
      output: `Error: Tool mapping not found for '${toolName}'. This may be a configuration issue.`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }

  log.debug({ appId: managed.appId }, 'Executing tool');

  const httpClient = ctx.httpClients.get(managed.appId);
  if (!httpClient && ctx.connectionManager && context) {
    ctx.connectionManager.setContext(managed.appId, {
      agentId: context.agentId,
      channelId: context.channelId,
      workspaceId: context.workspaceId,
    });
  }

  if (httpClient) {
    return executeToolViaHttp(ctx, managed, originalToolName, input, httpClient, context);
  }

  if (!managed.client) {
    return {
      output: `Error: MCA client not available for tool '${toolName}'. The MCA may not be running.`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }

  try {
    managed.lastUsed = new Date();
    const result = await managed.client.callTool({ name: originalToolName, arguments: input });

    let output = '';
    const attachments: Array<{ url: string; mime: string; filename?: string }> = [];
    const content = result.content as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
      resource?: { uri?: string; mimeType?: string; text?: string };
    }>;
    for (const item of content) {
      if (item.type === 'text' && item.text) {
        output += item.text;
      } else if (item.type === 'image' && item.data && item.mimeType) {
        attachments.push({
          url: `data:${item.mimeType};base64,${item.data}`,
          mime: item.mimeType,
        });
      } else if (item.type === 'resource' && item.resource?.uri) {
        attachments.push({
          url: item.resource.uri,
          mime: item.resource.mimeType || 'application/octet-stream',
          filename: item.resource.text,
        });
      }
    }
    output = truncateToolOutput(output, toolName, managed.appId);
    const isError = result.isError === true;
    log.debug({ appId: managed.appId, attachmentCount: attachments.length }, 'Tool execution succeeded');
    return { output, isError, mcaId: managed.mcaId, ...(attachments.length > 0 ? { attachments } : {}) };
  } catch (error: any) {
    log.error({ err: error, toolName, appId: managed.appId }, 'Tool execution failed');
    captureException(error, { context: 'executeToolStdio', toolName, appId: managed.appId });
    return {
      output: `Error executing tool '${toolName}': ${error.message}`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }
}

export async function executeToolViaHttp(
  ctx: ToolsContext,
  managed: ManagedMca,
  toolName: string,
  input: Record<string, any>,
  httpClient: McaHttpClient,
  context?: {
    agentId?: string;
    channelId?: string;
    appId?: string;
    userId?: string;
    workspaceId?: string;
    userDisplayName?: string;
    userAvatarUrl?: string;
    signal?: AbortSignal;
  },
  isRetryAfterRespawn = false,
): Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }> {
  try {
    managed.lastUsed = new Date();
    ctx.containerManager.touch(managed.containerKey || managed.mcaId);

    const callbackHost = managed.containerKey ? ctx.containerBackendHost : 'localhost';
    const executionContext = {
      userId: context?.userId || 'system',
      workspaceId: context?.workspaceId,
      userDisplayName: context?.userDisplayName,
      userAvatarUrl: context?.userAvatarUrl,
      agentId: context?.agentId,
      channelId: context?.channelId,
      appId: managed.appId,
      requestId: `req-${Date.now()}`,
      callbackUrl: `http://${callbackHost}:${ctx.config.serverPort}/mca/callback/${managed.appId}`,
    };

    const result = await httpClient.callTool(toolName, input, executionContext, {
      signal: context?.signal,
    });

    let output = '';
    const attachments: Array<{ url: string; mime: string; filename?: string }> = [];
    if (result.success && result.result !== undefined) {
      const r: any = result.result;
      if (typeof r === 'string') {
        output = r;
      } else if (typeof r?.output === 'string') {
        // Handler returned { output: string, attachments: [...] } shape
        // (attachments are extracted separately from the response wrapper)
        output = r.output;
      } else if (r?.content && Array.isArray(r.content)) {
        // MCP tool result format: { content: [{type:'text', text: ...}, ...] }
        // When a handler returns the MCP shape explicitly (e.g. `return { content: [...] }`),
        // concatenate all text parts into the persisted output string so downstream
        // renderers see the raw markdown/text, not the wrapper object.
        output = r.content
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n');
      } else {
        output = JSON.stringify(r, null, 2);
      }
    } else if (result.error) {
      output = `Error: ${result.error.message || result.error.code}`;
    }

    // Extract attachments from explicit attachments field on the result wrapper
    if (result.attachments && Array.isArray(result.attachments)) {
      for (const a of result.attachments) {
        if (a?.url && a?.mime) {
          attachments.push({
            url: a.url,
            mime: a.mime,
            filename: a.filename,
          });
        }
      }
    }

    output = truncateToolOutput(output, toolName, managed.appId);
    const isError = !result.success;
    log.debug({ appId: managed.appId, attachmentCount: attachments.length }, 'HTTP tool execution succeeded');
    return { output, isError, mcaId: managed.mcaId, ...(attachments.length > 0 ? { attachments } : {}) };
  } catch (error: any) {
    // Rewrite transport-level abort so the LLM sees the tool did NOT
    // commit any side effect — raw HttpClient errors leak URLs and read
    // ambiguous about completion.
    if (error?.code === 'ABORTED') {
      log.info(
        { toolName, appId: managed.appId },
        'HTTP tool execution cancelled by caller',
      );
      return {
        output: `Tool execution was cancelled before completion. The action did not run; do not assume any side effect was committed.`,
        isError: true,
        mcaId: managed.mcaId,
      };
    }

    // Self-healing for the stale-map class: the container died outside our
    // bookkeeping (idle-killed on the execution host, OOM, agent restart) but
    // the manager still holds its entry and port. Drop the stale state,
    // respawn once, and retry the call — instead of surfacing "fetch failed"
    // to the user for up to a full idle window. Guarded by isRetryAfterRespawn
    // so a genuinely broken MCA fails after one respawn attempt, not a loop.
    if (error?.code === 'CONNECTION_FAILED' && !isRetryAfterRespawn) {
      log.warn(
        { toolName, appId: managed.appId, mcaId: managed.mcaId },
        'Container unreachable — dropping stale entry, respawning and retrying once',
      );
      try {
        ctx.mcas.delete(managed.appId);
        ctx.httpClients.delete(managed.appId);
        // Clear the container manager's own map entry (the container is
        // already gone; the remote rm is best-effort and swallowed).
        await ctx.containerManager.stop(managed.containerKey || managed.mcaId);
        const fresh = await ctx.getOrSpawn(managed.appId);
        const freshClient = ctx.httpClients.get(managed.appId);
        if (fresh?.status === 'ready' && freshClient) {
          return executeToolViaHttp(ctx, fresh, toolName, input, freshClient, context, true);
        }
        log.error(
          { appId: managed.appId, status: fresh?.status },
          'Respawn after connection failure did not reach ready state',
        );
      } catch (respawnError: any) {
        log.error(
          { err: respawnError, appId: managed.appId },
          'Respawn after connection failure failed',
        );
      }
    }

    log.error({ err: error, toolName, appId: managed.appId }, 'HTTP tool execution failed');
    captureException(error, { context: 'executeToolHttp', toolName, appId: managed.appId });
    return {
      output: `Error executing tool '${toolName}': ${error.message}`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }
}
