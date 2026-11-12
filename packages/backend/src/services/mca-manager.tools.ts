/**
 * MCA Manager — Tool management
 *
 * Static tool loading/caching, tool discovery, and tool execution
 * (both stdio and HTTP transports).
 */

import { McaToolAnnotationsSchema, REMOTE_MCA_ID, type RemoteToolResultPayload } from '@teros/shared';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Db } from 'mongodb';
import { captureException } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import type { McaConnectionManager } from './mca-connection-manager';
import type { McaContainerManager } from './mca-container-manager';
import type { McaHttpClient } from './mca-http-client';
import type { McaService } from './mca-service';
import { MACHINE_UNREACHABLE_HINT, type RemoteDeviceGateway } from './remote-device-gateway';
import type { RemoteOfflineNotifier } from './remote-offline-notifier';
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
import { issueMcaCallGrant } from './mca-call-grants';

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
  /** Teros Remote tunnel gateway — routes mca.teros.remote app instances (no container). */
  remoteGateway?: RemoteDeviceGateway;
  /** Transfer plane (v0.7.0, REQ-14): bridges pull-file/push-file to the tunnel transfer messages. */
  transferService?: import('./remote-transfer-service').RemoteTransferService;
  /** T-REM-7: posts "device offline / back online" system events to the channel. */
  remoteOfflineNotifier?: RemoteOfflineNotifier;
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
    /** UI path (app.execute-tool): skip the 200K LLM-context truncation. */
    skipTruncation?: boolean;
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
    // Fail-closed: appId is mandatory. The old fallback searched the global
    // ctx.mcas map by tool name / app-name prefix, which could resolve to
    // another tenant's app instance — a cross-tenant access bug.
    // @fixme nira - 2026.08.14 : removed cross-tenant fallback (incident-2026-08-14)
    const err = new Error(
      `[McaManager] executeTool called without appId for tool '${toolName}'. ` +
        'appId is mandatory — refusing to resolve via global fallback (cross-tenant security).',
    );
    log.error({ toolName }, err.message);
    captureException(err, { context: 'executeTool.missingAppId', toolName });
    return {
      output: `Error: Tool '${toolName}' cannot be executed without an appId. This is a security requirement.`,
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

  // MUW-REQ-12b — the critical rule on the agent path: a personal app never
  // runs inside a shared conversation. Same gate as app.execute-tool (UI path);
  // covers HTTP and stdio MCAs alike because every call goes through here.
  if (context?.channelId) {
    const app = await ctx.mcaService.getApp(managed.appId);
    if (app && (await ctx.mcaService.isAppBlockedInChannel(app, context.channelId))) {
      log.info({ appId: managed.appId, channelId: context.channelId, toolName }, 'PERSONAL_APP_BLOCKED');
      return {
        output:
          `Error: PERSONAL_APP_BLOCKED — the app '${app.name}' is personal and cannot be used in a shared conversation. ` +
          'Ask the member who installed it to make it shared, or continue in a personal conversation.',
        isError: true,
        mcaId: managed.mcaId,
      };
    }
  }

  // Teros Remote: app instances of mca.teros.remote never spawn a container.
  // The call is tunneled to the paired machine through RemoteDeviceGateway
  // (docs/specs/remote/teros-remote.md § MCA Routing). Same chokepoint as the
  // container path, so the executor's permission gate, ask flow and
  // instrumentation above are untouched; the app stays in 'standby' here.
  if (managed.mcaId === REMOTE_MCA_ID) {
    return executeToolViaRemote(ctx, managed, toolName, input, context);
  }

  // Cached not-ready health only blocks execution when the MCA is actually
  // running (status 'ready') — i.e. the process is up but reports itself sick
  // (expired OAuth, broken credentials…). When the MCA is NOT running
  // (standby/error/stopping), the cached health is a snapshot of a *dormant*
  // process, not a diagnosis: a health check without forceSpawn caches
  // `unknown`/`not_ready` for MCAs that were never started. Returning that as
  // a terminal error here would deadlock wake-on-demand — the only path that
  // can start the MCA is this very tool call (getOrSpawn below). Regression:
  // after a backend restart, every container MCA (containerMode per-app) sat
  // blocked on `MCA_NOT_READY (status: standby)` until another restart.
  if (managed.status === 'ready') {
    const cachedHealth = getCachedHealthIfNotReady(ctx, managed.appId);
    if (cachedHealth) {
      log.debug({ appId: managed.appId }, 'MCA running but not ready, returning cached health error');
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

  // Scope is a visibility flag only — it controls which channels can use
  // an app (personal apps are blocked in public channels). It does NOT affect
  // credential resolution. All apps use app-level credentials (secrets, env
  // vars). Per-user credential storage (app_user_auth) was removed to simplify
  // the system — one app, one set of credentials.

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
    return executeToolViaHttp(ctx, managed, originalToolName, input, httpClient, context, false);
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
    // For stdio transport, inject per-user credentials into tool arguments
    // under a reserved key. The MCA SDK stdio server extracts and applies
    // them per-call via context.getUserSecrets() (MUW-F3).
    const stdioArgs = input;
    const result = await managed.client.callTool({ name: originalToolName, arguments: stdioArgs });

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
    output = truncateToolOutput(output, toolName, managed.appId, context?.skipTruncation === true);
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

/**
 * Tunnel a tool call to the paired machine of an `mca.teros.remote` app
 * instance. Output shaping mirrors `executeToolViaHttp` so filesystem/bash
 * results render identically whatever the target (spec § Unified machine tool
 * surface); structured errors keep their code + hint so agents self-correct
 * (FORBIDDEN lists the roots, MACHINE_UNREACHABLE says how to reconnect).
 *
 * T-REM-7: when the gateway reports MACHINE_UNREACHABLE with a diagnostic in
 * `error.details`, and the call carries a `channelId`, we also post a system
 * event into the channel so the *user* sees "midgar is offline — run
 * `teros-remote start`" without depending on the agent relaying it. The
 * notifier rate-limits per device (5 min) so retry loops don't spam.
 */
export async function executeToolViaRemote(
  ctx: ToolsContext,
  managed: ManagedMca,
  toolName: string,
  input: Record<string, any>,
  context?: {
    agentId?: string;
    channelId?: string;
    appId?: string;
    userId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
    /** UI path (app.execute-tool): skip the 200K LLM-context truncation. */
    skipTruncation?: boolean;
  },
): Promise<{ output: string; isError: boolean; mcaId: string }> {
  const originalToolName = managed.toolNameMapping.get(toolName);
  if (!originalToolName) {
    return {
      output: `Error: Tool mapping not found for '${toolName}'. This may be a configuration issue.`,
      isError: true,
      mcaId: managed.mcaId,
    };
  }
  managed.lastUsed = new Date();

  // @todo alice - 2026.10.18 : REQ-10 asks the bash permission prompt to state
  // the real scope («full access as user <name> — NOT limited to <roots>») from
  // the device's hello; today the ask renders tools.json's placeholder text.
  // Needs a hook in the executor's permission prose (permission-manager) that
  // can read ctx.remoteGateway.getConnectedDevice({ appId }).hello.
  let result: RemoteToolResultPayload;
  if (!ctx.remoteGateway) {
    result = {
      success: false,
      duration: 0,
      error: {
        code: 'MACHINE_UNREACHABLE',
        message: 'Teros Remote gateway is not available on this backend.',
        hint: MACHINE_UNREACHABLE_HINT,
      },
    };
  } else if (
    (originalToolName === 'pull-file' || originalToolName === 'push-file') &&
    ctx.transferService
  ) {
    // (handled below — single-file transfer plane)
    // Transfer plane (v0.7.0, REQ-14): pull-file/push-file run over the
    // dedicated transfer messages — bytes never transit a tool result.
    const wsId = context?.workspaceId;
    if (!wsId) {
      result = {
        success: false,
        duration: 0,
        error: {
          code: 'INVALID_ARGUMENTS',
          message: `${originalToolName} needs a workspace context to resolve the /workspace path.`,
        },
      };
    } else {
      const transferArgs = {
        appId: managed.appId,
        workspaceId: wsId,
        filePath: String(input.filePath ?? ''),
        ...(input.destinationPath ? { destinationPath: String(input.destinationPath) } : {}),
        ...(input.sourcePath ? { sourcePath: String(input.sourcePath) } : {}),
        ...(input.mode ? { mode: input.mode as 'create' | 'overwrite' | 'resume' } : {}),
        ...(input.resumeToken ? { resumeToken: String(input.resumeToken) } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
      };
      const tr =
        originalToolName === 'pull-file'
          ? await ctx.transferService.pullFile(transferArgs)
          : await ctx.transferService.pushFile({
              ...transferArgs,
              sourcePath: String(input.sourcePath ?? ''),
            });
      if ('error' in tr && tr.error) {
        result = { success: false, duration: 0, error: tr.error };
      } else {
        result = { success: true, duration: (tr as { durationMs?: number }).durationMs ?? 0, result: tr };
      }
    }
  } else {
    // Directory plane (v0.8.0): pull/push/sync-directory orchestrate per-file
    // transfers on the daemon and can run for minutes — give them a budget
    // well beyond the default tool-call timeout.
    const isDirectoryTool =
      originalToolName === 'pull-directory' ||
      originalToolName === 'push-directory' ||
      originalToolName === 'sync-directory';
    result = await ctx.remoteGateway.dispatch(
      { appId: managed.appId },
      {
        tool: originalToolName,
        arguments: input,
        signal: context?.signal,
        ...(isDirectoryTool ? { timeoutMs: 30 * 60_000 } : {}),
      },
    );
  }

  // T-REM-7: surface the failure to the *user* as a channel system event, not
  // just to the LLM. The notifier is wired from bootstrap and rate-limits per
  // device; we fire-and-forget so a slow channel write never delays the tool
  // response back to the agent.
  if (
    !result.success &&
    result.error?.code === 'MACHINE_UNREACHABLE' &&
    context?.channelId &&
    ctx.remoteOfflineNotifier
  ) {
    const details = (result.error.details ?? {}) as Record<string, unknown>;
    const diagnostic = details.diagnostic as
      | 'device_offline'
      | 'device_unknown'
      | 'device_revoked'
      | 'session_dead'
      | undefined;
    if (diagnostic) {
      const lastSeenAt =
        typeof details.lastSeenAt === 'string' ? new Date(details.lastSeenAt) : undefined;
      const lastSeenAgeMs =
        lastSeenAt instanceof Date && !Number.isNaN(lastSeenAt.getTime())
          ? Math.max(0, Date.now() - lastSeenAt.getTime())
          : null;
      const device =
        typeof details.deviceId === 'string'
          ? ({
              deviceId: details.deviceId,
              name: (details.deviceName as string | undefined) ?? 'remote machine',
              hostname: (details.hostname as string | undefined) ?? '',
              lastSeenAt,
            } as any)
          : null;
      void ctx.remoteOfflineNotifier
        .notifyOffline(
          context.channelId,
          { diagnostic, device, lastSeenAgeMs },
          { appId: managed.appId, deviceId: (details.deviceId as string | undefined) ?? undefined },
        )
        .catch((err) =>
          log.warn({ err, appId: managed.appId }, 'remote offline notification failed'),
        );
    }
  }

  let output = '';
  if (result.success && result.result !== undefined) {
    const r: any = result.result;
    if (typeof r === 'string') {
      output = r;
    } else if (typeof r?.output === 'string') {
      output = r.output;
    } else if (r?.content && Array.isArray(r.content)) {
      output = r.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n');
    } else {
      output = JSON.stringify(r, null, 2);
    }
  } else if (result.error) {
    // Keep the structured shape: the LLM reads code + hint, renderers can parse it.
    output = JSON.stringify(
      {
        error: result.error.code,
        message: result.error.message,
        ...(result.error.hint ? { hint: result.error.hint } : {}),
        ...(result.error.details ? { details: result.error.details } : {}),
        // TIMEOUT / CANCELLED on bash carry partial stdout/stderr as the result.
        ...(result.result !== undefined ? { partialResult: result.result } : {}),
      },
      null,
      2,
    );
  } else {
    output = result.success ? '' : 'Error: remote call failed without details';
  }

  output = truncateToolOutput(output, toolName, managed.appId, context?.skipTruncation === true);
  if (!result.success) {
    log.warn({ appId: managed.appId, tool: originalToolName, code: result.error?.code }, 'Remote tool call failed');
  } else {
    log.debug({ appId: managed.appId, tool: originalToolName, duration: result.duration }, 'Remote tool call succeeded');
  }
  return { output, isError: !result.success, mcaId: managed.mcaId };
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
    /** UI path (app.execute-tool): skip the 200K LLM-context truncation. */
    skipTruncation?: boolean;
  },
  isRetryAfterRespawn = false,
): Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }> {
  try {
    managed.lastUsed = new Date();
    ctx.containerManager.touch(managed.containerKey || managed.mcaId);

    const callbackHost = managed.containerKey ? ctx.containerBackendHost : 'localhost';
    const callbackSegment = context?.userId
      ? issueMcaCallGrant({
          appId: managed.appId,
          userId: context.userId,
          channelId: context.channelId,
          workspaceId: context.workspaceId,
          agentId: context.agentId,
        })
      : managed.appId;
    const executionContext = {
      userId: context?.userId || 'system',
      workspaceId: context?.workspaceId,
      userDisplayName: context?.userDisplayName,
      userAvatarUrl: context?.userAvatarUrl,
      agentId: context?.agentId,
      channelId: context?.channelId,
      appId: managed.appId,
      requestId: `req-${Date.now()}`,
      callbackUrl: `http://${callbackHost}:${ctx.config.serverPort}/mca/callback/${callbackSegment}`,
      // MUW-F3: per-execution credentials for personal apps — scoped to
      // this call only, no global WS push, no race between concurrent users.
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
      const message = result.error.message || result.error.code;
      output = /^\[[A-Z][A-Z0-9_]*\] /.test(message) ? message : `Error: ${message}`;
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

    output = truncateToolOutput(output, toolName, managed.appId, context?.skipTruncation === true);
    const isError = !result.success;

    // Self-healing: if the container rejected the request with a signature
    // error ("missing signature or toolCallId"), the HTTP client's signing
    // secret may be stale or missing. This happens when the container was
    // started by a previous backend session and the in-memory callbackTokens
    // map was cleared on restart. Drop the stale HTTP client, respawn the
    // container (which generates a fresh token), and retry once.
    if (isError && !isRetryAfterRespawn && result.error?.code === 'UNAUTHORIZED'
        && /missing signature or toolCallId/i.test(result.error.message || '')) {
      log.warn(
        { toolName, appId: managed.appId, mcaId: managed.mcaId },
        'Container rejected unsigned request — dropping stale HTTP client, respawning and retrying',
      );
      try {
        ctx.mcas.delete(managed.appId);
        ctx.httpClients.delete(managed.appId);
        await ctx.containerManager.stop(managed.containerKey || managed.mcaId);
        const fresh = await ctx.getOrSpawn(managed.appId);
        const freshClient = ctx.httpClients.get(managed.appId);
        if (fresh?.status === 'ready' && freshClient) {
          return executeToolViaHttp(ctx, fresh, toolName, input, freshClient, context, true);
        }
        log.error(
          { appId: managed.appId, status: fresh?.status },
          'Respawn after signature rejection did not reach ready state',
        );
      } catch (respawnError: any) {
        log.error(
          { err: respawnError, appId: managed.appId },
          'Respawn after signature rejection failed',
        );
      }
    }

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
