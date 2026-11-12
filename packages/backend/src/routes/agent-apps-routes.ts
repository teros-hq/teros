/**
 * Agent Apps Routes
 *
 * HTTP endpoints for Agent Apps station → host communication.
 *
 * POST /api/agent-apps/announce
 *   Stations call this when they start up or register new apps.
 *   Teros receives the announcement, updates the catalog, and broadcasts
 *   a WebSocket event to connected clients so they can refresh.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import type { AgentAppsBridge } from '../services/agent-apps-bridge';
import type { AnnouncePayload, CallbackRequest } from '../services/agent-apps';
import { isCallbackRequest, CallbackHandlers } from '../services/agent-apps';
import { createLogger } from '../lib/logger';

const log = createLogger('AgentAppsRoutes');

export interface AgentAppsRoutesConfig {
  db: Db;
  bridge: AgentAppsBridge;
  /** Token that stations must send to authenticate announcements */
  announceToken?: string;
  /** Optional callback to broadcast catalog updates to connected WS clients */
  onCatalogUpdated?: () => void;
  /** Callback handlers for storage/files/lifecycle (created if not provided) */
  callbackHandlers?: CallbackHandlers;
  /** Base path for object storage */
  objectStoragePath?: string;
}

export function createAgentAppsRoutes(config: AgentAppsRoutesConfig) {
  const { db, bridge, announceToken, onCatalogUpdated } = config;
  const catalog = db.collection('mca_catalog');
  const callbackHandlers = config.callbackHandlers ?? new CallbackHandlers({
    db,
    objectStoragePath: config.objectStoragePath,
  });

  return async function handleAgentAppsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    // POST /api/agent-apps/announce
    if (url === '/api/agent-apps/announce' && req.method === 'POST') {
      await handleAnnounce(req, res);
      return true;
    }

    // GET /api/agent-apps/stations
    if (url === '/api/agent-apps/stations' && req.method === 'GET') {
      await handleListStations(req, res);
      return true;
    }

    // POST /api/agent-apps/callback
    if (url === '/api/agent-apps/callback' && req.method === 'POST') {
      await handleCallback(req, res);
      return true;
    }

    return false;
  };

  // ---------------------------------------------------------------------------
  // POST /api/agent-apps/announce
  // ---------------------------------------------------------------------------

  async function handleAnnounce(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      // 1. Authenticate
      if (announceToken) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${announceToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token' }));
          log.warn('Unauthorized announce attempt');
          return;
        }
      }

      // 2. Parse body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString();
      let payload: AnnouncePayload;

      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // 3. Validate required fields
      if (!payload.stationId || !payload.stationUrl || !Array.isArray(payload.apps)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Missing required fields: stationId, stationUrl, apps[]',
        }));
        return;
      }

      // 4. Process through the adapter (decoupled — no DB access)
      const result = bridge.handleAnnounce(payload);

      // 5. Persist discovered apps to mca_catalog (Teros-specific)
      for (const app of result.discovered) {
        const now = new Date().toISOString();
        const announceApp = payload.apps.find((a) => a.appId === app.appId);

        await catalog.updateOne(
          { mcaId: app.appId },
          {
            $set: {
              name: announceApp?.name ?? app.name,
              description: announceApp?.description ?? `Agent App: ${app.name}`,
              tagline: announceApp?.tagline,
              version: app.version,
              author: announceApp?.author,
              category: announceApp?.category ?? 'other',
              icon: announceApp?.icon,
              keywords: announceApp?.keywords ?? [],
              tools: app.tools.map((t) => t.name),
              toolsDetailed: app.tools.map((t) => ({
                name: t.name,
                description: t.description,
              })),
              status: 'active',
              updatedAt: now,
              'runtime.transport': 'agent-apps',
              'runtime.stationUrl': app.stationUrl,
              'runtime.stationId': app.stationId,
              'runtime.version': app.version,
              availability: {
                enabled: true,
                hidden: false,
                system: false,
                multi: true,
                role: 'user',
              },
            },
            $setOnInsert: {
              mcaId: app.appId,
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }

      // 6. Populate static tools cache on the bridge
      for (const app of result.discovered) {
        bridge.setStaticToolsForMca(app.appId, app.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object' as const,
            properties: (t.parameters as any)?.properties ?? {},
            required: (t.parameters as any)?.required,
          },
          ...(t.annotations ? { annotations: t.annotations as any } : {}),
        })));
      }

      // 7. Notify connected clients
      if (result.discovered.length > 0 && onCatalogUpdated) {
        onCatalogUpdated();
      }

      log.info({
        stationId: payload.stationId,
        accepted: result.accepted,
        rejected: result.rejected.length,
        stationRegistered: result.stationRegistered,
      }, 'Announce processed');

      // 8. Respond
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        accepted: result.accepted,
        rejected: result.rejected,
        stationRegistered: result.stationRegistered,
      }));
    } catch (error: any) {
      log.error({ err: error }, 'Error handling announce');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message ?? 'Internal server error' }));
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/agent-apps/stations
  // ---------------------------------------------------------------------------

  async function handleListStations(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const statuses = bridge.getStationStatuses();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stations: statuses }));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  // ---------------------------------------------------------------------------
  // POST /api/agent-apps/callback
  // ---------------------------------------------------------------------------

  async function handleCallback(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      // Parse body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks).toString();
      let payload: unknown;

      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }

      // Validate that this is a callback request
      if (!isCallbackRequest(payload)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Invalid callback request: missing or unknown type',
        }));
        return;
      }

      // Dispatch to the appropriate handler
      const response = await callbackHandlers.handle(payload as CallbackRequest);

      log.debug({
        type: (payload as any).type,
        installationId: (payload as any).installationId,
        success: response.success,
      }, 'Callback processed');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error: any) {
      log.error({ err: error }, 'Error handling callback');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: error.message ?? 'Internal server error' }));
    }
  }
}
