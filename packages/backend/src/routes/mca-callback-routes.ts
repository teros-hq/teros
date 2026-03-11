/**
 * MCA Callback Routes
 *
 * HTTP endpoints for MCA → Backend communication.
 * These routes receive callbacks from MCAs running in containers.
 *
 * Base path: /mca/callback/:channelId/*
 *
 * @see docs/rfc-003-mca-endpoints.md
 */

import type {
  // Layer 2: Events
  EmitEventRequest,
  EmitEventResponse,
  // Layer 5: Auth
  GetSystemSecretsRequest,
  GetSystemSecretsResponse,
  GetUserSecretsRequest,
  GetUserSecretsResponse,
  ReportAuthErrorRequest,
  ReportAuthErrorResponse,
  // Lifecycle
  ReportHealthRequest,
  ReportHealthResponse,
  UpdateUserSecretsRequest,
  UpdateUserSecretsResponse,
} from '@teros/shared';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import type { AuthManager } from '../auth/auth-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import * as resources from './mca-resources-handlers';

// ============================================================================
// TYPES
// ============================================================================

export interface McaCallbackRoutesConfig {
  db: Db;
  secretsManager: SecretsManager;
  authManager: AuthManager;
  workspaceService: WorkspaceService;
  volumeService: VolumeService;
}

interface McaCallbackContext {
  channelId: string;
  appId?: string;
  mcaId?: string;
  userId?: string;
  path: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Parse URL to extract context and path parameters
 * URL format: /mca/callback/:channelId/:path
 */
function parseCallbackUrl(url: string): McaCallbackContext | null {
  const match = url.match(/^\/mca\/callback\/([^/]+)\/(.+)$/);
  if (!match) return null;

  return {
    channelId: match[1],
    path: '/' + match[2],
  };
}

/**
 * Extract path parameters from resource paths
 * e.g., /resources/agents/agent_123 -> { resource: 'agents', id: 'agent_123' }
 */
function parseResourcePath(path: string): {
  resource: string;
  id?: string;
  subResource?: string;
  subId?: string;
} | null {
  // /resources/:resource
  const simple = path.match(/^\/resources\/([^/]+)$/);
  if (simple) {
    return { resource: simple[1] };
  }

  // /resources/:resource/:id
  const withId = path.match(/^\/resources\/([^/]+)\/([^/]+)$/);
  if (withId) {
    return { resource: withId[1], id: withId[2] };
  }

  // /resources/:resource/:id/:subResource
  const withSub = path.match(/^\/resources\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (withSub) {
    return { resource: withSub[1], id: withSub[2], subResource: withSub[3] };
  }

  // /resources/:resource/:id/:subResource/:subId
  const withSubId = path.match(/^\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (withSubId) {
    return {
      resource: withSubId[1],
      id: withSubId[2],
      subResource: withSubId[3],
      subId: withSubId[4],
    };
  }

  return null;
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * Create MCA callback routes handler
 */
export function createMcaCallbackRoutes(cfg: McaCallbackRoutesConfig) {
  const { db, secretsManager, authManager, workspaceService, volumeService } = cfg;

  return async function handleMcaCallbackRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    console.log(`[MCA Callback] Received request: ${req.method} ${url}`);

    // Only handle /mca/callback/* routes
    if (!url.startsWith('/mca/callback/')) {
      return false;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, X-App-Id, X-Mca-Id',
      });
      res.end();
      return true;
    }

    // Parse URL
    const ctx = parseCallbackUrl(url);
    console.log(`[MCA Callback] Parsed context:`, ctx);
    if (!ctx) {
      sendJson(res, 400, { error: 'Invalid callback URL format' });
      return true;
    }

    // Get app ID and MCA ID from headers
    ctx.appId = req.headers['x-app-id'] as string | undefined;
    ctx.mcaId = req.headers['x-mca-id'] as string | undefined;
    console.log(`[MCA Callback] Headers - appId: ${ctx.appId}, mcaId: ${ctx.mcaId}`);

    // Get userId from app ownership
    if (ctx.appId) {
      console.log(`[MCA Callback] Looking up app: ${ctx.appId}`);
      const app = await db.collection('apps').findOne({ appId: ctx.appId });
      console.log(`[MCA Callback] App found:`, app ? 'yes' : 'no');
      if (app?.ownerId) {
        ctx.userId = app.ownerId;
      }
    }
    console.log(`[MCA Callback] userId: ${ctx.userId}`);

    // Route to handler
    try {
      // Check for resource paths first
      if (ctx.path.startsWith('/resources/')) {
        return await handleResourceRoute(req, res, ctx, db, workspaceService, volumeService);
      }

      // Check for data storage paths
      if (ctx.path.startsWith('/data/')) {
        return await handleDataRoute(req, res, ctx, db);
      }

      // Other routes
      switch (ctx.path) {
        // Layer 2: Events
        case '/events':
          return await handleEmitEvent(req, res, ctx);

        // Layer 5: Auth
        case '/secrets/system':
          return await handleGetSystemSecrets(req, res, ctx, secretsManager);
        case '/secrets/user':
          return await handleGetUserSecrets(req, res, ctx, authManager);
        case '/secrets/user/update':
          return await handleUpdateUserSecrets(req, res, ctx, authManager);
        case '/auth/error':
          return await handleAuthError(req, res, ctx);

        // Lifecycle
        case '/health':
          return await handleHealthReport(req, res, ctx);

        default:
          sendJson(res, 404, { error: 'Unknown callback endpoint', path: ctx.path });
          return true;
      }
    } catch (error) {
      console.error('[MCA Callback] Error:', error);
      sendJson(res, 500, {
        error: 'Internal error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      return true;
    }
  };
}

// ============================================================================
// DATA STORAGE ROUTING
// ============================================================================

/**
 * Handle MCA data storage requests
 * Path format: /data/:key or /data/:key/:scope
 */
async function handleDataRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  db: Db,
): Promise<boolean> {
  // Parse the key from path: /data/:key
  const match = ctx.path.match(/^\/data\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(res, 400, { error: 'Invalid data path format. Use /data/:key' });
    return true;
  }

  const key = match[1];
  const explicitScope = match[2]; // Optional explicit scope

  if (!ctx.appId) {
    sendJson(res, 401, { error: 'App ID required for data storage' });
    return true;
  }

  const body = await parseBody<{
    action?: 'get' | 'set' | 'delete' | 'list';
    value?: any;
    scope?: string;
  }>(req);

  // Determine scope: explicit > body > userId
  const scope = explicitScope || body.scope || ctx.userId;
  if (!scope) {
    sendJson(res, 400, { error: 'Scope required (workspaceId or userId)' });
    return true;
  }

  const collection = db.collection('mca_data');
  const action = body.action || 'get';

  console.log(`[MCA Data] ${action} key="${key}" scope="${scope}" appId="${ctx.appId}"`);

  try {
    switch (action) {
      case 'get': {
        const doc = await collection.findOne({
          appId: ctx.appId,
          scope,
          key,
        });
        sendJson(res, 200, {
          success: true,
          key,
          scope,
          value: doc?.value ?? null,
          exists: !!doc,
        });
        break;
      }

      case 'set': {
        if (body.value === undefined) {
          sendJson(res, 400, { error: 'Value required for set action' });
          return true;
        }
        await collection.updateOne(
          { appId: ctx.appId, scope, key },
          {
            $set: {
              value: body.value,
              updatedAt: new Date().toISOString(),
            },
            $setOnInsert: {
              appId: ctx.appId,
              scope,
              key,
              createdAt: new Date().toISOString(),
            },
          },
          { upsert: true },
        );
        sendJson(res, 200, { success: true, key, scope });
        break;
      }

      case 'delete': {
        const result = await collection.deleteOne({
          appId: ctx.appId,
          scope,
          key,
        });
        sendJson(res, 200, {
          success: true,
          key,
          scope,
          deleted: result.deletedCount > 0,
        });
        break;
      }

      case 'list': {
        // List all keys for this app+scope
        const docs = await collection
          .find({ appId: ctx.appId, scope })
          .project({ key: 1, updatedAt: 1 })
          .toArray();
        sendJson(res, 200, {
          success: true,
          scope,
          keys: docs.map((d) => ({ key: d.key, updatedAt: d.updatedAt })),
        });
        break;
      }

      default:
        sendJson(res, 400, { error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('[MCA Data] Error:', error);
    sendJson(res, 500, {
      error: 'Data operation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return true;
}

// ============================================================================
// RESOURCE ROUTING
// ============================================================================

async function handleResourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  db: Db,
  workspaceService: any,
  volumeService: any,
): Promise<boolean> {
  console.log(`[MCA Callback] handleResourceRoute called, path: ${ctx.path}`);

  if (!ctx.userId) {
    sendJson(res, 401, { error: 'User not authenticated' });
    return true;
  }

  const resourceCtx: resources.ResourceContext = {
    userId: ctx.userId,
    channelId: ctx.channelId,
    appId: ctx.appId,
  };

  const parsed = parseResourcePath(ctx.path);
  console.log(`[MCA Callback] Parsed resource path:`, parsed);
  if (!parsed) {
    sendJson(res, 404, { error: 'Invalid resource path', path: ctx.path });
    return true;
  }

  const { resource, id, subResource, subId } = parsed;
  const method = req.method || 'POST';

  // Parse body once at the beginning
  let body: any = {};
  try {
    body = await parseBody<any>(req);
    console.log(`[MCA Callback] Body parsed:`, body);
  } catch (e) {
    console.log(`[MCA Callback] Body parse error:`, e);
  }

  // Route based on resource type and method
  switch (resource) {
    // ========== AGENTS ==========
    case 'agents':
      if (!id) {
        // /resources/agents
        if (method === 'POST') {
          if (body.action === 'list' || !body.action) {
            await resources.handleAgentList(res, resourceCtx, db, body);
          } else if (body.action === 'create') {
            await resources.handleAgentCreate(res, resourceCtx, db, body);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && !subResource) {
        // /resources/agents/:id
        if (method === 'POST') {
          if (body.action === 'get' || !body.action) {
            await resources.handleAgentGet(res, resourceCtx, db, id);
          } else if (body.action === 'update') {
            await resources.handleAgentUpdate(res, resourceCtx, db, id, body);
          } else if (body.action === 'delete') {
            await resources.handleAgentDelete(res, resourceCtx, db, id);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && subResource === 'apps') {
        // /resources/agents/:id/apps
        await resources.handleAgentAppsList(res, resourceCtx, db, id);
      } else if (id && subResource === 'providers' && !subId) {
        // /resources/agents/:id/providers
        if (body.action === 'get' || !body.action) {
          await resources.handleAgentProvidersGet(res, resourceCtx, db, id);
        } else if (body.action === 'set') {
          await resources.handleAgentProvidersSet(res, resourceCtx, db, id, body);
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } else if (id && subResource === 'providers' && subId === 'preferred') {
        // /resources/agents/:id/providers/preferred
        if (body.action === 'set' || !body.action) {
          await resources.handleAgentPreferredProviderSet(res, resourceCtx, db, id, body);
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } else {
        sendJson(res, 404, { error: 'Invalid agent resource path' });
      }
      break;

    // ========== WORKSPACES ==========
    case 'workspaces':
      if (!id) {
        // /resources/workspaces
        if (method === 'POST') {
          if (body.action === 'list' || !body.action) {
            await resources.handleWorkspaceList(res, resourceCtx, db);
          } else if (body.action === 'create') {
            await resources.handleWorkspaceCreate(res, resourceCtx, db, workspaceService, body);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && !subResource) {
        // /resources/workspaces/:id
        if (method === 'POST') {
          if (body.action === 'get' || !body.action) {
            await resources.handleWorkspaceGet(res, resourceCtx, db, id);
          } else if (body.action === 'update') {
            await resources.handleWorkspaceUpdate(res, resourceCtx, db, id, body);
          } else if (body.action === 'archive') {
            await resources.handleWorkspaceArchive(res, resourceCtx, db, id);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && subResource === 'members' && !subId) {
        // /resources/workspaces/:id/members
        await resources.handleWorkspaceMemberAdd(res, resourceCtx, db, id, body);
      } else if (id && subResource === 'members' && subId) {
        // /resources/workspaces/:id/members/:userId
        if (body.action === 'remove') {
          await resources.handleWorkspaceMemberRemove(res, resourceCtx, db, id, subId);
        } else if (body.action === 'update') {
          await resources.handleWorkspaceMemberUpdate(res, resourceCtx, db, id, subId, body);
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } else if (id && subResource === 'apps') {
        // /resources/workspaces/:id/apps
        await resources.handleWorkspaceAppList(res, resourceCtx, db, { workspaceId: id });
      } else if (id && subResource === 'agents') {
        // /resources/workspaces/:id/agents
        await resources.handleAgentList(res, resourceCtx, db, { workspaceId: id });
      } else {
        sendJson(res, 404, { error: 'Invalid workspace resource path' });
      }
      break;

    // ========== APPS ==========
    case 'apps':
      if (!id) {
        // /resources/apps
        if (method === 'POST') {
          if (body.action === 'list' || !body.action) {
            await resources.handleAppList(res, resourceCtx, db, body);
          } else if (body.action === 'install') {
            await resources.handleAppInstall(res, resourceCtx, db, body, volumeService, workspaceService);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && !subResource) {
        // /resources/apps/:id
        if (method === 'POST') {
          if (body.action === 'get' || !body.action) {
            await resources.handleAppGet(res, resourceCtx, db, id);
          } else if (body.action === 'uninstall') {
            await resources.handleAppUninstall(res, resourceCtx, db, id);
          } else if (body.action === 'rename') {
            await resources.handleAppRename(res, resourceCtx, db, id, body);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else if (id && subResource === 'access') {
        // /resources/apps/:id/access
        await resources.handleAppAccessList(res, resourceCtx, db, id);
      } else {
        sendJson(res, 404, { error: 'Invalid app resource path' });
      }
      break;

    // ========== CATALOG ==========
    case 'catalog':
      await resources.handleCatalogList(res, resourceCtx, db, body);
      break;

    // ========== AGENT CORES ==========
    case 'agent-cores':
      await resources.handleAgentCoresList(res, resourceCtx, db);
      break;

    // ========== ACCESS CONTROL ==========
    case 'access':
      if (!id) {
        // /resources/access - grant
        await resources.handleAccessGrant(res, resourceCtx, db, body);
      } else if (id && subResource) {
        // /resources/access/:agentId/:appId - revoke
        await resources.handleAccessRevoke(res, resourceCtx, db, id, subResource);
      } else {
        sendJson(res, 404, { error: 'Invalid access resource path' });
      }
      break;

    // ========== PROVIDERS ==========
    case 'providers':
      if (!id) {
        // /resources/providers
        if (method === 'POST') {
          if (body.action === 'list' || !body.action) {
            await resources.handleProviderList(res, resourceCtx, db);
          } else {
            sendJson(res, 400, { error: 'Invalid action' });
          }
        } else {
          sendJson(res, 405, { error: 'Method not allowed' });
        }
      } else {
        sendJson(res, 404, { error: 'Invalid provider resource path' });
      }
      break;

    default:
      sendJson(res, 404, { error: 'Unknown resource type', resource });
  }

  return true;
}

// ============================================================================
// LAYER 2: EVENTS
// ============================================================================

async function handleEmitEvent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
): Promise<boolean> {
  const body = await parseBody<EmitEventRequest>(req);

  console.log(`[MCA Callback] Event from ${ctx.appId}: ${body.event}`, {
    channelId: ctx.channelId,
    payload: body.payload,
  });

  // TODO: Route event to WebSocket subscribers

  const response: EmitEventResponse = {
    delivered: true,
    recipientCount: 0,
  };

  sendJson(res, 200, response);
  return true;
}

// ============================================================================
// LAYER 5: AUTH
// ============================================================================

async function handleGetSystemSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  secretsManager: SecretsManager,
): Promise<boolean> {
  const body = await parseBody<GetSystemSecretsRequest>(req);

  console.log(`[MCA Callback] System secrets request from ${ctx.appId} (mcaId: ${ctx.mcaId})`, {
    keys: body.keys,
  });

  // Get secrets from SecretsManager (reads from .secrets/mcas/<mcaId>/credentials.json)
  let secrets: Record<string, string> | null = null;

  if (ctx.mcaId) {
    const mcaSecrets = secretsManager.mca(ctx.mcaId);

    if (mcaSecrets) {
      // Filter by requested keys if specified
      if (body.keys && body.keys.length > 0) {
        secrets = {};
        for (const key of body.keys) {
          if (key in mcaSecrets) {
            secrets[key] = String(mcaSecrets[key]);
          }
        }
        if (Object.keys(secrets).length === 0) {
          secrets = null;
        }
      } else {
        // Return all secrets (convert to string values)
        secrets = {};
        for (const [key, value] of Object.entries(mcaSecrets)) {
          secrets[key] = String(value);
        }
      }
    }
  }

  const response: GetSystemSecretsResponse = { secrets };

  sendJson(res, 200, response);
  return true;
}

async function handleGetUserSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  authManager: AuthManager,
): Promise<boolean> {
  const body = await parseBody<GetUserSecretsRequest>(req);

  console.log(`[MCA Callback] User secrets request from ${ctx.appId}`, {
    keys: body.keys,
    channelId: ctx.channelId,
    userId: ctx.userId,
  });

  // Need both appId and userId
  if (!ctx.appId) {
    const response: GetUserSecretsResponse = {
      secrets: null,
      authenticated: false,
      error: 'No app ID provided',
    };
    sendJson(res, 200, response);
    return true;
  }

  if (!ctx.userId) {
    const response: GetUserSecretsResponse = {
      secrets: null,
      authenticated: false,
      error: 'No user ID available (app owner not found)',
    };
    sendJson(res, 200, response);
    return true;
  }

  try {
    // Get decrypted credentials from AuthManager
    const credentials = await authManager.get(ctx.userId, ctx.appId);

    if (!credentials) {
      const response: GetUserSecretsResponse = {
        secrets: null,
        authenticated: false,
        error: 'No user credentials configured for this app',
      };
      sendJson(res, 200, response);
      return true;
    }

    // Filter by requested keys if specified
    let secrets: Record<string, string>;
    if (body.keys && body.keys.length > 0) {
      secrets = {};
      for (const key of body.keys) {
        if (key in credentials) {
          secrets[key] = String(credentials[key]);
        }
      }
    } else {
      // Return all credentials as strings
      secrets = {};
      for (const [key, value] of Object.entries(credentials)) {
        secrets[key] = String(value);
      }
    }

    const response: GetUserSecretsResponse = {
      secrets: Object.keys(secrets).length > 0 ? secrets : null,
      authenticated: Object.keys(secrets).length > 0,
    };

    sendJson(res, 200, response);
    return true;
  } catch (error) {
    console.error('[MCA Callback] Error getting user secrets:', error);
    const response: GetUserSecretsResponse = {
      secrets: null,
      authenticated: false,
      error: error instanceof Error ? error.message : 'Failed to get credentials',
    };
    sendJson(res, 200, response);
    return true;
  }
}

async function handleUpdateUserSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  authManager: AuthManager,
): Promise<boolean> {
  const body = await parseBody<UpdateUserSecretsRequest>(req);

  console.log(`[MCA Callback] User secrets update from ${ctx.appId}`, {
    keys: Object.keys(body.secrets),
    channelId: ctx.channelId,
    userId: ctx.userId,
  });

  // Need both appId and userId
  if (!ctx.appId || !ctx.userId || !ctx.mcaId) {
    const response: UpdateUserSecretsResponse = {
      success: false,
      error: 'Missing appId, userId, or mcaId',
    };
    sendJson(res, 200, response);
    return true;
  }

  try {
    // Get existing credentials and merge with new ones
    const existing = (await authManager.get(ctx.userId, ctx.appId)) || {};
    const merged = { ...existing, ...body.secrets };

    // Save updated credentials
    await authManager.set(ctx.userId, ctx.appId, ctx.mcaId, merged);

    const response: UpdateUserSecretsResponse = {
      success: true,
    };
    sendJson(res, 200, response);
    return true;
  } catch (error) {
    console.error('[MCA Callback] Error updating user secrets:', error);
    const response: UpdateUserSecretsResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update credentials',
    };
    sendJson(res, 200, response);
    return true;
  }
}

async function handleAuthError(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
): Promise<boolean> {
  const body = await parseBody<ReportAuthErrorRequest>(req);

  console.log(`[MCA Callback] Auth error from ${ctx.appId}:`, {
    error: body.error,
    message: body.message,
    canRetry: body.canRetry,
    channelId: ctx.channelId,
  });

  // TODO: Handle different error types

  const response: ReportAuthErrorResponse = {
    action: body.canRetry ? 'retry' : 'reauth',
  };

  sendJson(res, 200, response);
  return true;
}

// ============================================================================
// LIFECYCLE
// ============================================================================

async function handleHealthReport(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
): Promise<boolean> {
  const body = await parseBody<ReportHealthRequest>(req);

  console.log(`[MCA Callback] Health report from ${ctx.appId}:`, {
    status: body.status,
    message: body.message,
    issues: body.issues?.length || 0,
  });

  // TODO: Update MCA health status in registry

  const response: ReportHealthResponse = {
    acknowledged: true,
  };

  sendJson(res, 200, response);
  return true;
}
