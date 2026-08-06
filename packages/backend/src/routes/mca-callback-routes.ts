/**
 * MCA Callback Routes
 *
 * HTTP endpoints for MCA → Backend communication.
 * These routes receive callbacks from MCAs running in containers.
 *
 * Base path: /mca/callback/:channelId/*
 *
 *
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
import type { McaOAuth } from '../auth/mca-oauth';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
import type { McaContainerManager } from '../services/mca-container-manager';
import type { Rules } from '../models/mca-event-subscriptions';
import type { AgentProvisioningService } from '../services/agent-provisioning-service';
import type { McaService } from '../services/mca-service';
import type { PubSubService } from '../services/pubsub-service';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import * as resources from './mca-resources-handlers';
import { config } from '../config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// TYPES
// ============================================================================

export interface McaCallbackRoutesConfig {
  db: Db;
  secretsManager: SecretsManager;
  authManager: AuthManager;
  workspaceService: WorkspaceService;
  volumeService: VolumeService;
  /** Single creation path for agents (POST /resources/agents). */
  provisioningService: AgentProvisioningService;
  /**
   * Instalación de apps vía agente (`install-app` → POST /resources/apps).
   * Debe ser el singleton del contenedor (el que recibe setOnToolCacheInvalidate
   * del WebSocketHandler) para que el auto-grant a superagentes refresque las
   * tools de las conversaciones activas sin reiniciar.
   */
  mcaService: McaService;
  /**
   * PubSub usado para emitir `agent.created` cuando un agente crea otro agente
   * vía la herramienta `agent-create` (POST /resources/agents). Sin esto el
   * navbar de los clientes conectados no se entera (la ruta del UI sí emite).
   */
  pubSubService: PubSubService;
  mcaEventSubscriptionService?: MCAEventSubscriptionService;
  /**
   * Container manager used to verify MCA_CALLBACK_TOKEN on secret endpoints.
   * When provided, /secrets/system and /secrets/user require a valid Bearer token.
   */
  containerManager?: McaContainerManager;
  /**
   * Cliente OAuth de MCAs — usado para refrescar lazy el access_token al servir
   * `/secrets/user` cuando está vencido (TER-388). El backend es el ÚNICO dueño
   * del refresh_token (rotation-safe); los contenedores nunca refrescan por su
   * cuenta. Si no se pasa, el refresh lazy se omite (comportamiento legacy).
   */
  mcaOAuth?: McaOAuth;
  /**
   * Resolver del owner del channel — usado para Capa 2 de aislamiento
   * (TER-358). Cuando un MCA hace `createChannelSubscription` con un
   * `body.channelId` distinto al `ctx.channelId` del callback token, verificamos
   * que `channel.userId === ctx.userId`. Si no se pasa el callback, el check
   * queda desactivado (warn). En producción este callback es REQUIRED.
   */
  getChannelOwnerUserIdFn?: (channelId: string) => Promise<string | null>;
  /**
   * Callback to invalidate the in-memory tool executor cache for an agent.
   * When provided, grant/revoke access operations trigger an immediate hot-reload
   * so active conversations pick up the change without a backend restart.
   */
  invalidateToolCache?: (agentId: string) => Promise<void>;
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
  // No CORS header (L4): /mca/callback/* is a server-to-server endpoint called
  // only by MCA containers via the SDK, never by a browser. A wildcard ACAO here
  // is unnecessary attack surface.
  res.writeHead(status, {
    'Content-Type': 'application/json',
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
 * Authenticate an MCA → backend callback via the per-container callback token (A6).
 *
 * The SDK (`mca-sdk/backend-client.ts`) sends `Authorization: Bearer <token>` +
 * `X-App-Id` + `X-Mca-Id` on EVERY callback. The token was registered at spawn
 * time against the container key (the appId in per-app mode, the mcaId in shared
 * mode). Identity is derived from the VERIFIED key — never from the X-App-Id /
 * X-Mca-Id headers, which any caller could forge.
 *
 * Returns the verified container key, the trusted mcaId, and the raw header appId
 * (still to be re-validated against mcaId by the caller), or null when the token
 * is missing/invalid (→ 401).
 */
export function authenticateCallback(
  req: IncomingMessage,
  containerManager: McaContainerManager,
): { verifiedKey: string; mcaId: string; headerAppId?: string } | null {
  const authHeader = req.headers['authorization'];
  const bearerToken =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!bearerToken) return null;

  const headerAppId = req.headers['x-app-id'] as string | undefined;
  const headerMcaId = req.headers['x-mca-id'] as string | undefined;
  // Try the appId first (per-app, more specific), then the mcaId (shared mode).
  const candidateKeys = [headerAppId, headerMcaId].filter(Boolean) as string[];
  const verifiedKey = candidateKeys.find((key) => containerManager.verifyCallbackToken(key, bearerToken));
  if (!verifiedKey) return null;

  const mcaId = containerManager.getInfo(verifiedKey)?.mcaId ?? verifiedKey;
  return { verifiedKey, mcaId, headerAppId };
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
  const { db, secretsManager, authManager, workspaceService, volumeService, provisioningService, mcaService, pubSubService, mcaEventSubscriptionService, containerManager, mcaOAuth, invalidateToolCache, getChannelOwnerUserIdFn } = cfg;

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

    // ------------------------------------------------------------------
    // Callback authentication (A6 — TER-724 / SEC-5)
    //
    // EVERY callback route — not just /secrets/* — must present the per-container
    // callback token. Identity (mcaId, appId, userId, channel) is derived from the
    // VERIFIED key, never from the forgeable X-App-Id / X-Mca-Id headers or the URL
    // channelId. Previously the non-secret routes (/resources, /data, /events,
    // /subscriptions) skipped token verification and trusted those headers, so any
    // caller that could reach /mca/callback/ could impersonate another tenant.
    // (Network-layer defence — binding to loopback, M1 — is handled in SEC-6.)
    // ------------------------------------------------------------------
    if (!containerManager) {
      // Fail closed — without the token registry we cannot authenticate callers.
      sendJson(res, 503, { error: 'Callback endpoint unavailable: container manager not configured' });
      return true;
    }
    const auth = authenticateCallback(req, containerManager);
    if (!auth) {
      console.warn(`[MCA Callback] Rejected unauthenticated request path=${ctx.path}`);
      sendJson(res, 401, { error: 'Invalid or missing MCA callback token' });
      return true;
    }
    // Marca actividad: una llamada autenticada cuenta como "en uso". Los
    // contenedores con trabajo de fondo (p.ej. el watcher de Gmail) hacían polls
    // periódicos sin ejecutar tools vía el manager → morían por idle a los 30 min.
    // touch() los mantiene vivos mientras sigan llamando (TER-389).
    containerManager.touch(auth.verifiedKey);
    ctx.mcaId = auth.mcaId; // trusted: resolved from the verified container key

    // Resolve appId + userId from the app record. The header appId is honoured
    // ONLY when the app belongs to the verified mcaId, so a (shared) container can
    // act only as apps of its own mca — never as another mca's app.
    if (auth.headerAppId) {
      const app = await db.collection('apps').findOne({ appId: auth.headerAppId });
      if (app && app.mcaId === ctx.mcaId) {
        ctx.appId = auth.headerAppId; // trusted: token-verified container of this mca
        if (app.ownerId) {
          const workspace = await db.collection('workspaces').findOne({ workspaceId: app.ownerId });
          if (workspace?.ownerId) ctx.userId = workspace.ownerId;
        }
      }
    }

    // Bind the URL channelId to the authenticated user. We NEVER derive userId
    // FROM the channelId (the removed fallback was the A6 forgery vector). When a
    // userId is resolved, a channelId owned by someone else is rejected here; the
    // channel-scoped routes (/events, /subscriptions/channel) additionally require
    // a resolved userId of their own, so a valid token without X-App-Id cannot
    // reach them (fail closed rather than skip the binding).
    if (ctx.channelId && ctx.userId && getChannelOwnerUserIdFn) {
      const channelOwner = await getChannelOwnerUserIdFn(ctx.channelId);
      if (channelOwner && channelOwner !== ctx.userId) {
        console.warn(`[MCA Callback] Rejected channel ${ctx.channelId} not owned by user ${ctx.userId}`);
        sendJson(res, 403, { error: 'Channel does not belong to the authenticated MCA user' });
        return true;
      }
    }
    console.log(`[MCA Callback] Authenticated — mcaId=${ctx.mcaId} appId=${ctx.appId} userId=${ctx.userId} path=${ctx.path}`);

    // Route to handler
    try {
      // Check for resource paths first
      if (ctx.path.startsWith('/resources/')) {
        return await handleResourceRoute(req, res, ctx, db, workspaceService, volumeService, provisioningService, mcaService, pubSubService, mcaOAuth, invalidateToolCache);
      }

      // Check for data storage paths
      if (ctx.path.startsWith('/data/')) {
        return await handleDataRoute(req, res, ctx, db);
      }

      // Other routes
      switch (ctx.path) {
        // Layer 2: Events
        case '/events':
          return await handleEmitEvent(req, res, ctx, mcaEventSubscriptionService);

        // Layer 2: Subscriptions
        case '/subscriptions/channel':
          return await handleChannelSubscription(req, res, ctx, mcaEventSubscriptionService, getChannelOwnerUserIdFn);

        // Layer 5: Auth
        case '/secrets/system':
          return await handleGetSystemSecrets(req, res, ctx, secretsManager, containerManager);
        case '/secrets/user':
          return await handleGetUserSecrets(req, res, ctx, authManager, mcaOAuth, containerManager);
        case '/secrets/user/update':
          return await handleUpdateUserSecrets(req, res, ctx, authManager);
        case '/auth/error':
          return await handleAuthError(req, res, ctx);

        // Email notification (via Resend)
        case '/email/send':
          return await handleEmailSend(req, res, ctx, db, secretsManager);

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
  provisioningService: AgentProvisioningService,
  mcaService: McaService,
  pubSubService: PubSubService,
  mcaOAuth?: McaOAuth,
  invalidateToolCache?: (agentId: string) => Promise<void>,
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
            await resources.handleAgentCreate(res, resourceCtx, db, body, provisioningService, pubSubService);
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
            await resources.handleAppInstall(res, resourceCtx, db, body, mcaService, pubSubService);
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
      } else if (id && subResource === 'permissions') {
        // /resources/apps/:id/permissions
        if (body.action === 'set') {
          await resources.handleAppPermissionsSet(res, resourceCtx, db, id, body);
        } else {
          await resources.handleAppPermissionsGet(res, resourceCtx, db, id);
        }
      } else if (id && subResource === 'auth') {
        // /resources/apps/:id/auth — check auth status (agent-only read) or
        // show the auth widget to the user (inline in chat, default action)
        if (body.action === 'check') {
          await resources.handleAppCheckAuth(res, resourceCtx, db, id, mcaOAuth);
        } else {
          await resources.handleAppShowAuth(res, resourceCtx, db, id, mcaOAuth);
        }
      } else {
        sendJson(res, 404, { error: 'Invalid app resource path' });
      }
      break;

    // ========== CATALOG ==========
    case 'catalog':
      await resources.handleCatalogList(res, resourceCtx, db, body);
      break;

    // ========== ACCESS CONTROL ==========
    case 'access':
      if (!id) {
        // /resources/access - grant
        await resources.handleAccessGrant(res, resourceCtx, db, body, invalidateToolCache);
      } else if (id && subResource) {
        // /resources/access/:agentId/:appId - revoke
        await resources.handleAccessRevoke(res, resourceCtx, db, id, subResource, invalidateToolCache);
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

    // ========== SKILLS ==========
    case 'skills':
      if (!id) {
        // /resources/skills
        if (body.action === 'list' || (!body.action && !subResource)) {
          await resources.handleSkillList(res, resourceCtx, db, body);
        } else if (body.action === 'create') {
          await resources.handleSkillCreate(res, resourceCtx, db, body);
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } else if (id === 'access' && !subResource) {
        // /resources/skills/access — grant
        await resources.handleSkillGrantAccess(res, resourceCtx, db, body);
      } else if (id === 'access' && subResource && !subId) {
        // /resources/skills/access/:agentId/:skillId — revoke (subResource = agentId, subId = skillId)
        // Note: path is /resources/skills/access/:agentId/:skillId → resource=skills, id=access, subResource=agentId, subId=skillId
        sendJson(res, 400, { error: 'Missing skillId in path' });
      } else if (id === 'access' && subResource && subId) {
        // /resources/skills/access/:agentId/:skillId
        if (body.action === 'revoke') {
          await resources.handleSkillRevokeAccess(res, resourceCtx, db, subResource, subId);
        } else if (body.action === 'set-enabled') {
          await resources.handleSkillSetEnabled(res, resourceCtx, db, subResource, subId, body);
        } else {
          sendJson(res, 400, { error: 'Invalid action for skill access' });
        }
      } else if (id === 'agent' && subResource) {
        // /resources/skills/agent/:agentId
        await resources.handleSkillGetAgentSkills(res, resourceCtx, db, subResource);
      } else if (id && !subResource) {
        // /resources/skills/:skillId
        if (body.action === 'update') {
          await resources.handleSkillUpdate(res, resourceCtx, db, id, body);
        } else if (body.action === 'delete') {
          await resources.handleSkillDelete(res, resourceCtx, db, id);
        } else {
          sendJson(res, 400, { error: 'Invalid action' });
        }
      } else {
        sendJson(res, 404, { error: 'Invalid skill resource path' });
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
  mcaEventSubscriptionService?: MCAEventSubscriptionService,
): Promise<boolean> {
  // Channel-scoped route: require a token-derived userId, symmetric with
  // /subscriptions/channel. Without it the central channelId→owner binding is
  // skipped, so a valid-token container that omits X-App-Id could otherwise emit
  // events into any user's channel (A6). Fail closed.
  if (!ctx.userId) {
    sendJson(res, 401, { error: 'User not authenticated' });
    return true;
  }

  const body = await parseBody<EmitEventRequest>(req);

  console.log(`[MCA Callback] Event from ${ctx.appId}: ${body.event}`, {
    channelId: ctx.channelId,
    payload: body.payload,
  });

  if (mcaEventSubscriptionService && body.event) {
    await mcaEventSubscriptionService.dispatch({
      topic: body.event,
      payload: {
        ...(body.payload ?? {}),
        // Inject channelId and appId so subscribers can filter by them
        channelId: ctx.channelId,
        appId: ctx.appId,
      },
    });
  }

  const response: EmitEventResponse = {
    delivered: true,
    recipientCount: 0,
  };

  sendJson(res, 200, response);
  return true;
}

// ============================================================================
// LAYER 2: SUBSCRIPTIONS
// ============================================================================

/**
 * Handle MCA channel subscription management.
 * Allows MCAs to create or delete subscriptions_channel entries on behalf of a channel.
 *
 * POST /subscriptions/channel
 * Body: { action: 'create' | 'delete', topic, channelId, rules?, mode?, subscriptionId? }
 */
async function handleChannelSubscription(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  mcaEventSubscriptionService?: MCAEventSubscriptionService,
  getChannelOwnerUserIdFn?: (channelId: string) => Promise<string | null>,
): Promise<boolean> {
  if (!mcaEventSubscriptionService) {
    sendJson(res, 503, { error: 'MCAEventSubscriptionService not available' });
    return true;
  }

  const body = await parseBody<{
    action: 'create' | 'delete' | 'delete-by-topic';
    topic?: string;
    channelId?: string;
    rules?: Rules;
    mode?: 'notify' | 'wake';
    subscriptionId?: string;
  }>(req);

  console.log(`[MCA Callback] Subscription ${body.action} from ${ctx.appId}`, {
    topic: body.topic,
    channelId: body.channelId ?? ctx.channelId,
    mode: body.mode,
  });

  /**
   * Capa 2 (TER-358): si el MCA pide operar sobre un `body.channelId` que NO
   * es el `ctx.channelId` del callback token, verificar que ese channel
   * pertenece al user del token. Sin esta verificación, un MCA atacante
   * podría crear subscriptions en channels ajenos (vector C-1 del audit).
   *
   * Cuando `body.channelId` coincide con `ctx.channelId`, el callback token
   * ya garantiza la pertenencia (firma del token + channelId en la URL).
   */
  async function assertChannelOwnership(targetChannelId: string): Promise<true | { error: string }> {
    if (targetChannelId === ctx.channelId) return true;
    if (!ctx.userId) {
      return { error: 'Cannot verify cross-channel ownership: callback token has no userId.' };
    }
    if (!getChannelOwnerUserIdFn) {
      console.warn(
        `[MCA Callback] Capa 2 ownership check skipped (no resolver) for channel=${targetChannelId} app=${ctx.appId}. Configure getChannelOwnerUserIdFn in bootstrap.`,
      );
      return true;
    }
    const ownerUserId = await getChannelOwnerUserIdFn(targetChannelId);
    if (ownerUserId !== ctx.userId) {
      return {
        error: `Channel ${targetChannelId} does not belong to user ${ctx.userId} (owner=${ownerUserId}).`,
      };
    }
    return true;
  }

  if (body.action === 'create') {
    if (!body.topic || !body.mode) {
      sendJson(res, 400, { error: 'Missing required fields: topic, mode' });
      return true;
    }
    const targetChannelId = body.channelId ?? ctx.channelId;
    const ownership = await assertChannelOwnership(targetChannelId);
    if (ownership !== true) {
      sendJson(res, 403, { error: `[FORBIDDEN] ${ownership.error}` });
      return true;
    }
    const sub = await mcaEventSubscriptionService.createChannelSubscription({
      topic: body.topic,
      channelId: targetChannelId,
      rules: body.rules ?? [],
      mode: body.mode,
    });
    sendJson(res, 200, { success: true, subscription: sub });
  } else if (body.action === 'delete') {
    if (!body.subscriptionId) {
      sendJson(res, 400, { error: 'Missing required field: subscriptionId' });
      return true;
    }
    const deleted = await mcaEventSubscriptionService.deleteChannelSubscription(body.subscriptionId);
    sendJson(res, 200, { success: true, deleted });
  } else if (body.action === 'delete-by-topic') {
    if (!body.topic) {
      sendJson(res, 400, { error: 'Missing required field: topic' });
      return true;
    }
    const targetChannelId = body.channelId ?? ctx.channelId;
    const ownership = await assertChannelOwnership(targetChannelId);
    if (ownership !== true) {
      sendJson(res, 403, { error: `[FORBIDDEN] ${ownership.error}` });
      return true;
    }
    const count = await mcaEventSubscriptionService.deleteChannelSubscriptionsByTopicAndChannel(
      body.topic,
      targetChannelId,
    );
    sendJson(res, 200, { success: true, deletedCount: count });
  } else {
    sendJson(res, 400, { error: 'Invalid action. Use: create | delete | delete-by-topic' });
  }

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
  containerManager?: McaContainerManager,
): Promise<boolean> {
  const body = await parseBody<GetSystemSecretsRequest>(req);

  // In per-app mode the verifiedKey (stored in ctx.mcaId) is the appId, not the
  // mcaId. Resolve it to the real mcaId via the container manager so we can look
  // up the correct .secrets/mcas/<mcaId>/credentials.json file.
  const resolvedMcaId = resolveMcaIdForCallback(ctx, containerManager);

  console.log(`[MCA Callback] System secrets request from ${ctx.appId} (mcaId: ${ctx.mcaId} → resolved: ${resolvedMcaId})`, {
    keys: body.keys,
  });

  // Get secrets from SecretsManager (reads from .secrets/mcas/<mcaId>/credentials.json)
  let secrets: Record<string, string> | null = null;

  if (resolvedMcaId) {
    const mcaSecrets = secretsManager.mca(resolvedMcaId);

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

/**
 * Resuelve el mcaId real a partir del contexto del callback. En per-app mode
 * `ctx.mcaId` es el appId (`app_…`); lo resolvemos vía el container manager para
 * obtener el mcaId del catálogo. Compartido por `/secrets/system` y `/secrets/user`.
 */
function resolveMcaIdForCallback(
  ctx: McaCallbackContext,
  containerManager?: McaContainerManager,
): string | undefined {
  let resolvedMcaId = ctx.mcaId;
  if (resolvedMcaId && resolvedMcaId.startsWith('app_') && containerManager) {
    const info = containerManager.getInfo(resolvedMcaId);
    if (info?.mcaId) resolvedMcaId = info.mcaId;
  }
  return resolvedMcaId;
}

/** Margen para refrescar antes de que el access_token expire (5 min). */
const OAUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Parsea `EXPIRY_DATE` a epoch ms. El backend lo persiste como ISO string
 * (`mca-oauth.ts`), pero toleramos epoch ms numérico por robustez frente a
 * credenciales legacy. Devuelve null si no se puede determinar.
 */
export function parseExpiryToMs(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  const asNum = Number(s);
  if (Number.isFinite(asNum) && asNum > 1e12) return asNum; // epoch ms
  const parsed = Date.parse(s); // ISO
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * ¿Procede refrescar el access_token OAuth? Solo si hay refresh_token y el
 * expiry conocido está vencido o a <5 min. Sin EXPIRY_DATE parseable no
 * forzamos refresh (no es un MCA OAuth, o no sabemos cuándo expira).
 */
export function shouldRefreshOAuthToken(credentials: Record<string, unknown>): boolean {
  if (!credentials.REFRESH_TOKEN) return false;
  const expiry = parseExpiryToMs(credentials.EXPIRY_DATE);
  if (expiry === null) return false;
  return expiry <= Date.now() + OAUTH_REFRESH_SKEW_MS;
}

async function handleGetUserSecrets(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  authManager: AuthManager,
  mcaOAuth?: McaOAuth,
  containerManager?: McaContainerManager,
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
    let credentials = await authManager.get(ctx.userId, ctx.appId);

    if (!credentials) {
      const response: GetUserSecretsResponse = {
        secrets: null,
        authenticated: false,
        error: 'No user credentials configured for this app',
      };
      sendJson(res, 200, response);
      return true;
    }

    // Refresh lazy del access_token OAuth (TER-388). El backend es el único
    // dueño del refresh_token: si el token está vencido (o a <5 min) y hay
    // refresh_token, lo refrescamos y persistimos aquí, de forma rotation-safe,
    // antes de servirlo. Así los contenedores siempre reciben un token fresco y
    // nunca refrescan por su cuenta (evita el antipatrón de doble dueño que
    // invalida el refresh_token de Google). Beneficia a todos los MCA OAuth.
    if (mcaOAuth && shouldRefreshOAuthToken(credentials)) {
      const resolvedMcaId = resolveMcaIdForCallback(ctx, containerManager);
      if (resolvedMcaId) {
        const result = await mcaOAuth.refreshToken(ctx.userId, ctx.appId, resolvedMcaId);
        if (result.success) {
          console.log(`[MCA Callback] Refreshed OAuth token for ${ctx.appId} (mcaId: ${resolvedMcaId})`);
          credentials = (await authManager.get(ctx.userId, ctx.appId)) ?? credentials;
        } else {
          // No rompemos el endpoint: servimos el token viejo. El MCA verá el 401
          // del provider y el usuario reconectará. Log loud para diagnóstico.
          console.warn(
            `[MCA Callback] OAuth refresh failed for ${ctx.appId} (mcaId: ${resolvedMcaId}): ${result.error}`,
          );
        }
      }
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

// ============================================================================
// EMAIL NOTIFICATION (via Resend)
// ============================================================================

/**
 * Handle email/send requests from the Messaging MCA.
 *
 * The MCA provides subject + content (email-safe HTML). The backend:
 *   1. Resolves the user's email from the channel context (userId → users collection)
 *   2. Takes the agent's HTML as-is — no wrapping template
 *   3. Appends a full-width Teros banner at the bottom (CTA → os.teros.ai)
 *   4. Sends via Resend from the configured from address
 *
 * The agent never sees the user's email or the Resend API key.
 */
async function handleEmailSend(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: McaCallbackContext,
  db: Db,
  secretsManager: SecretsManager,
): Promise<boolean> {
  // Parse request body
  const body = await parseBody<{ subject: string; content: string }>(req);

  if (!body.subject || !body.content) {
    sendJson(res, 400, { error: 'Missing required fields: subject, content' });
    return true;
  }

  // Resolve userId from context
  let userId = ctx.userId;

  // Fallback: resolve from channelId
  if (!userId && ctx.channelId) {
    const channel = await db.collection('channels').findOne({ channelId: ctx.channelId });
    if (channel?.userId) {
      userId = channel.userId;
    }
  }

  if (!userId) {
    sendJson(res, 401, { error: 'Cannot resolve user from channel context' });
    return true;
  }

  // Get user email from users collection
  const user = await db.collection<{ userId: string; profile?: { email?: string; displayName?: string } }>('users').findOne({ userId });
  if (!user?.profile?.email) {
    sendJson(res, 400, { error: 'User does not have an email address on file' });
    return true;
  }

  const userEmail = user.profile.email;

  // --- Teros banner (appended at the bottom of every notification email) ---
  // Full-width, dark, email-safe. CTA always links to os.teros.ai.
  const terosBanner = `
<!-- Teros Banner -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EFE9DB" style="background-color: #EFE9DB;">
  <tr>
    <td align="center" style="padding: 16px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px; width: 100%;">
        <tr>
          <td valign="middle" style="font-size: 13px; color: #18181B; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Teros &middot; Tu espacio de trabajo con IA</td>
          <td align="right" valign="middle">
            <a href="https://os.teros.ai" target="_blank" style="display: inline-block; padding: 8px 20px; background-color: #5E6AD2; color: #FFFFFF; text-decoration: none; font-size: 13px; font-weight: 600; border-radius: 6px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Ver en Teros &rarr;</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;

  // If the content is already a full HTML document, insert the banner before </body>.
  // Otherwise, wrap the fragment in a minimal document with the banner appended.
  let html: string;
  if (/<\/body>/i.test(body.content)) {
    html = body.content.replace(/<\/body>/i, terosBanner + '\n</body>');
  } else {
    html = '<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <meta http-equiv="X-UA-Compatible" content="IE=edge">\n</head>\n<body style="margin: 0; padding: 0;">\n' + body.content + '\n' + terosBanner + '\n</body>\n</html>';
  }

  // Get Resend API key from system secrets
  const emailSecret = secretsManager.system('email');
  if (!emailSecret?.resendApiKey) {
    sendJson(res, 503, { error: 'Resend API key not configured' });
    return true;
  }

  // Send via Resend
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(emailSecret.resendApiKey);

    const fromEmail = 'noreply@teros.ai';
    const fromName = config.email?.fromName || 'Teros';

    const resendResult = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: userEmail,
      subject: body.subject,
      html,
    });

    if (resendResult.error) {
      console.error('[MCA Callback] Resend error:', resendResult.error);
      sendJson(res, 500, { error: `Resend error: ${resendResult.error.message}` });
      return true;
    }

    console.log(`[MCA Callback] Notification email sent to ${userEmail}: "${body.subject}"`);

    sendJson(res, 200, {
      success: true,
      messageId: resendResult.data?.id,
      sentTo: userEmail,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MCA Callback] Error sending notification email:', message);
    sendJson(res, 500, { error: `Failed to send email: ${message}` });
    return true;
  }
}
