/**
 * Agent Apps Storage Routes — Standalone HTTP endpoints
 *
 * Exposes the AgentApps CallbackHandlers (document store, object storage,
 * lifecycle) as individual HTTP endpoints that work WITHOUT requiring
 * AGENT_APPS_ENABLED=true. This allows existing MCAs to use the new storage
 * layer without migrating to the Agent Apps process system.
 *
 * Unlike agent-apps-routes.ts, these routes do NOT require the AgentAppsBridge —
 * they only need a Db connection and an objectStoragePath.
 *
 * Endpoints:
 *   POST /api/agent-apps/storage/put       → storage_put
 *   POST /api/agent-apps/storage/get       → storage_get
 *   POST /api/agent-apps/storage/query     → storage_query
 *   POST /api/agent-apps/storage/update    → storage_update
 *   POST /api/agent-apps/storage/delete    → storage_delete
 *   POST /api/agent-apps/objects/put       → file_object_put
 *   POST /api/agent-apps/objects/get       → file_object_get
 *   POST /api/agent-apps/objects/delete    → file_object_delete
 *   POST /api/agent-apps/objects/list      → file_object_list
 *   POST /api/agent-apps/volume/read-dir  → file_volume_read_dir
 *   POST /api/agent-apps/volume/read-file → file_volume_read_file
 *   POST /api/agent-apps/volume/write-file → file_volume_write_file
 *   POST /api/agent-apps/volume/delete    → file_volume_delete
 *   POST /api/agent-apps/volume/stat      → file_volume_stat
 *   POST /api/agent-apps/volume/mkdir     → file_volume_mkdir
 *   POST /api/agent-apps/lifecycle/install   → lifecycle_install
 *   POST /api/agent-apps/lifecycle/uninstall → lifecycle_uninstall
 *   GET  /objects/:objectId  → serve object file (public, no auth); with
 *        ?w=&h=&fit=&format=&q= a transformed image (OBJ-REQ-3)
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { CallbackHandlers, isCallbackRequest } from '../services/agent-apps';
import type { CallbackRequest, CallbackResponse } from '../services/agent-apps';
import { ensureStorageIndexes as _ensureStorageIndexes } from '../services/agent-apps/storage-indexes';
import { AGENT_APPS_CALLBACK_ROUTES } from './agent-apps-callback-paths';
import { createLogger } from '../lib/logger';
import { authenticateCallback } from './mca-callback-routes';
import type { McaContainerManager } from '../services/mca-container-manager';
import { applyInlineSafetyHeaders, buildFrameAncestorsDirective } from '../lib/content-safety';
import { config as globalConfig } from '../config';
import {
  isTransformableContentType,
  parseObjectTransform,
  transformObject,
} from '../services/object-transforms';

const log = createLogger('AgentAppsStorageRoutes');

export interface AgentAppsStorageRoutesConfig {
  db: Db;
  /** Base path for object storage (default: /data/agent-apps-objects) */
  objectStoragePath?: string;
  /** Pre-existing CallbackHandlers instance (optional — created if not provided) */
  callbackHandlers?: CallbackHandlers;
  /**
   * Required to authenticate incoming callers on this standalone surface.
   * Without it the endpoints fail closed (503). See
   * docs/specs/security/20261014_datastore-isolation.md (P0a).
   */
  containerManager?: McaContainerManager;
  /**
   * Security settings for the public object-serving path (F1 containment).
   * `corsAllowedOrigins` feeds the CSP frame-ancestors directive so our own
   * app origins (which embed object URLs in iframes) keep working while third
   * parties cannot. Defaults to the global config's CORS allowlist.
   */
  security?: { corsAllowedOrigins: readonly string[] };
}

/**
 * Map of URL path → callback type.
 * Each endpoint receives a JSON body (without `type`) and we inject the
 * correct `type` field before dispatching to CallbackHandlers.handle().
 *
 * Derived from the shared `AGENT_APPS_CALLBACK_ROUTES` map (callback-form paths
 * without the `/api` prefix) by prepending `/api` to each key.
 */
const ROUTE_MAP: Record<string, CallbackRequest['type']> = Object.fromEntries(
  Object.entries(AGENT_APPS_CALLBACK_ROUTES).map(([path, type]) => [`/api${path}`, type]),
);

export function createAgentAppsStorageRoutes(config: AgentAppsStorageRoutesConfig) {
  const { db, containerManager } = config;
  const callbackHandlers =
    config.callbackHandlers ??
    new CallbackHandlers({
      db,
      objectStoragePath: config.objectStoragePath,
    });

  // F1 containment: the frame-ancestors directive for inline-served
  // browser-executable objects. Derived from the CORS allowlist (our own app
  // origins) — see buildFrameAncestorsDirective for why 'self' alone would
  // break the app viewer's iframe embed.
  const frameAncestors = buildFrameAncestorsDirective(
    config.security?.corsAllowedOrigins ?? globalConfig.security.corsAllowedOrigins,
  );

  return async function handleAgentAppsStorageRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    // POST → storage / objects / lifecycle endpoints
    if (req.method === 'POST') {
      const callbackType = ROUTE_MAP[url];
      if (!callbackType) return false;
      await handleStorageEndpoint(req, res, callbackType);
      return true;
    }

    // GET → serve a public object file (no auth, no token)
    // URL pattern: /objects/:objectId
    // HEAD is answered too (same handler, empty body): probing tools (curl -I,
    // link checkers) got a misleading 404 during the 2026-10-31 playwright
    // incident because only GET was handled.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/objects/')) {
      await handlePublicObjectGet(req, res, url, req.method === 'HEAD');
      return true;
    }

    return false;
  };

  // -----------------------------------------------------------------------
  // Endpoint handler — shared logic for all storage endpoints
  // -----------------------------------------------------------------------

  async function handleStorageEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
    callbackType: CallbackRequest['type'],
  ): Promise<void> {
    try {
      // Parse JSON body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString();

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }

      // ── Incoming authentication (SEC: datastore-isolation P0a) ──────────
      // This standalone surface historically trusted `installationId` from
      // the body with NO authentication — a cross-tenant hole (Secture H-08
      // / 2026-08-14 incident class). We now require the same per-MCA bearer
      // token the authenticated /mca/callback/* path uses, and derive the
      // tenant scope from the VERIFIED token identity, overwriting whatever
      // the body claims. Identity logic mirrors mca-callback-routes.ts.
      if (!containerManager) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Authentication unavailable' }));
        return;
      }
      const auth = authenticateCallback(req, containerManager);
      if (!auth) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }
      // The header appId is honoured ONLY when the app belongs to the verified
      // mcaId, so a token can act only as its own mca's apps. The installation
      // scope IS the trusted appId; the workspace is the app's ownerId.
      let trustedAppId: string | undefined;
      let trustedWorkspaceId: string | undefined;
      if (auth.headerAppId) {
        const app = await db.collection('apps').findOne({ appId: auth.headerAppId });
        if (app && (app as any).mcaId === auth.mcaId) {
          trustedAppId = auth.headerAppId;
          trustedWorkspaceId =
            typeof (app as any).ownerId === 'string' ? ((app as any).ownerId as string) : undefined;
        }
      }
      if (!trustedAppId) {
        // No installation scope derivable from the token → refuse rather than
        // fall back to a body-supplied (forgeable) installationId.
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No installation scope for token' }));
        return;
      }
      // Force server-derived scope; never trust the body's tenant selectors.
      payload.installationId = trustedAppId;
      if (trustedWorkspaceId) payload.workspaceId = trustedWorkspaceId;
      if (callbackType.startsWith('file_volume_') && !payload.workspaceId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No workspace scope for token' }));
        return;
      }

      // Inject the callback type so the payload matches the CallbackRequest shape
      const request = { ...payload, type: callbackType } as unknown;

      // Validate that the resulting object is a valid callback request
      if (!isCallbackRequest(request)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            error: `Invalid request for type '${callbackType}': missing required fields`,
          }),
        );
        return;
      }

      // Dispatch to the appropriate handler
      const response: CallbackResponse = await callbackHandlers.handle(request as CallbackRequest);

      log.debug(
        {
          type: callbackType,
          installationId: (request as any).installationId,
          success: response.success,
        },
        'Storage endpoint processed',
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error: any) {
      log.error({ err: error, type: callbackType }, 'Error handling storage endpoint');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: error.message ?? 'Internal server error',
        }),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Public object GET handler — serves an object file by objectId
  // URL pattern: /objects/:objectId
  // No auth, no token — public. Objects are immutable (cache headers: long).
  //
  // CACHE POLICY (security finding F5, 2026-11-02, review tn_KjOnSKdgygs1xbQu):
  // 200s keep `public, max-age=31536000, immutable` BY DESIGN: every
  // file_object_put mints a NEW random objectId and content is never
  // overwritten in place, so an objectId always resolves to the same bytes —
  // no revocation ever needs to change what an objectId serves. Dependents
  // measured before keeping it: the app viewer (HtmlPreview iframe on the
  // object URL), share-io file shares (302 → this URL) and the viewer's
  // "Open" button. 4xx/5xx carry `no-store` so a missing object is never
  // heuristically cached by shared proxies.
  // RESIDUAL F5 RISK (accepted + documented): /objects/:objectId is a public
  // capability URL (64-bit random id) NOT tied to any share — revoking a
  // share does not invalidate an object URL a visitor already obtained, and
  // a browser that fetched it keeps it for the cache lifetime. Closing that
  // needs signed/expiring object URLs (report rec. P1-6) — a model change,
  // deliberately out of scope here.
  // -----------------------------------------------------------------------

  async function handlePublicObjectGet(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    headOnly = false,
  ): Promise<void> {
    try {
      // Parse path: /objects/:objectId
      const queryIdx = url.indexOf('?');
      const pathPart = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
      const objectId = pathPart.replace('/objects/', '');

      if (!objectId || !/^obj_[a-f0-9]+$/.test(objectId)) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({ success: false, error: 'Object not found' }));
        return;
      }

      // Look up the object in MongoDB — no installationId needed (public)
      const objDoc = await db.collection('agent_app_objects').findOne({ objectId });

      if (!objDoc) {
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({ success: false, error: 'Object not found' }));
        return;
      }

      const filePath = objDoc.path as string;
      const contentType = (objDoc.contentType as string) ?? 'application/octet-stream';

      // Image transforms (OBJ-REQ-3): strict parameters, raster images only.
      const transform = parseObjectTransform(
        new URLSearchParams(queryIdx >= 0 ? url.slice(queryIdx + 1) : ''),
      );
      const transformError =
        transform.kind === 'invalid'
          ? transform.error
          : transform.kind === 'transform' && !isTransformableContentType(contentType)
            ? 'Transform parameters apply only to raster images'
            : null;
      if (transformError) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({ success: false, error: transformError }));
        return;
      }

      try {
        const served =
          transform.kind === 'transform'
            ? await transformObject(filePath, contentType, transform.options)
            : { data: await fs.readFile(filePath), contentType };
        const data = served.data;
        // F1 containment (review tn_KjOnSKdgygs1xbQu): a browser-executable
        // object (HTML/SVG/JS/XML) served inline here used to run in the
        // backend's own origin — Stored XSS with full reach of the session
        // cookie via /auth/session. The CSP sandbox gives it an opaque origin
        // (scripts still run, cookies/fetch are not), frame-ancestors keeps
        // embedding to our own app origins, and nosniff stops MIME-sniffing
        // a benign-looking type back into HTML. Non-executable types get
        // nosniff only. See applyInlineSafetyHeaders.
        const headers = applyInlineSafetyHeaders(
          {
            'Content-Type': served.contentType,
            'Content-Length': data.length.toString(),
            // Objects are immutable — cache aggressively
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
          served.contentType,
          frameAncestors,
        );
        res.writeHead(200, headers);
        res.end(headOnly ? undefined : data);
      } catch (error) {
        // A transform that fails on an existing file is a server error, not a
        // missing object.
        if (transform.kind === 'transform' && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
        res.writeHead(404, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({ success: false, error: 'Object file not found' }));
      }
    } catch (error: any) {
      log.error({ err: error }, 'Error serving public object');
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(
        JSON.stringify({
          success: false,
          error: error.message ?? 'Internal server error',
        }),
      );
    }
  }
}

/**
 * Ensure MongoDB indexes for AgentApps storage collections.
 * Called during bootstrap (always — not gated behind AGENT_APPS_ENABLED).
 *
 * Delegates to the canonical implementation in
 * `services/agent-apps/storage-indexes.ts` which covers:
 *   - agent_app_installations: unique on installationId, index on workspaceId, index on status
 *   - agent_app_objects: unique on objectId, index on installationId
 *   - agent_app_storage_*: dynamic — indexed lazily on first storage_put (see callback-handlers.ts)
 */
export async function ensureAgentAppsStorageIndexes(db: Db): Promise<void> {
  await _ensureStorageIndexes(db);
  log.info('AgentApps storage indexes ensured (installations + objects)');
}
