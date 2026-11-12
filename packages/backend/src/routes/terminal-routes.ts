/**
 * Terminal Routes — Even Terminal's /api/* HTTP contract.
 *
 * Reproduces even-terminal's REST + SSE contract so the Even phone app
 * connects to us directly. The app is just an SSE/REST client; it cannot
 * tell this apart from the official server.
 *
 * Auth: API token (from api_tokens collection) via ?token= query param
 * or Authorization: Bearer header — same tokens managed by /g2/tokens.
 *
 * Routes:
 *   GET  /health                    — health check (no auth)
 *   GET  /api/events?sessionId=     — SSE event stream
 *   GET  /api/sessions              — list sessions
 *   GET  /api/info                  — provider info
 *   GET  /api/status?sessionId=     — session status
 *   GET  /api/messages?sessionId=   — buffered messages
 *   GET  /api/sessions/:id/history  — conversation history
 *   POST /api/prompt                — send a prompt
 *   POST /api/permission-response   — respond to permission request
 *   POST /api/question-response     — respond to user question
 *   POST /api/interrupt             — interrupt running turn
 *   GET  /api/update-check          — version check stub
 *   GET  /api/metrics               — metrics stub
 *   POST /api/codex/ensure-app-server — codex stub
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { createTerminalProvider, type TerminalProvider } from './terminal-provider';
import { addClient, getMessages, emit as busEmit } from './terminal-bus';
import type { AgentWakeUpCallback } from '../handlers/event-handler';
import type { ChannelManager } from '../services/channel-manager';
import { type ApiTokenDoc, resolveApiToken } from '../auth/api-tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

type G2Token = ApiTokenDoc;

export interface TerminalRoutesConfig {
  db: Db;
  channelManager: ChannelManager;
  getWakeUpCallback: () => AgentWakeUpCallback;
  /**
   * Resolve a permission request via the in-memory PermissionManager.
   * Passed through to the terminal provider so respondPermission()
   * can unblock the agent loop when the G2 user taps Allow/Deny.
   */
  resolvePermission?: (requestId: string, granted: boolean) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// ─── Provider cache ───────────────────────────────────────────────────────────

// One provider per G2 token (cached after first use)
const providerCache = new Map<string, TerminalProvider>();

// Reverse index: channelId → provider, so we can route PubSub channel events
// to the correct terminal provider's onChannelEvent() without scanning all tokens.
const channelProviderIndex = new Map<string, TerminalProvider>();

function getOrCreateProvider(
  config: TerminalRoutesConfig,
  tokenDoc: G2Token,
): TerminalProvider {
  const cached = providerCache.get(tokenDoc.tokenHash);
  if (cached) return cached;

  const provider = createTerminalProvider({
    db: config.db,
    channelManager: config.channelManager,
    getWakeUpCallback: config.getWakeUpCallback,
    agentId: tokenDoc.agentId,
    userId: tokenDoc.userId,
    getChannelId: () => tokenDoc.channelId,
    setChannelId: async (channelId: string) => {
      tokenDoc.channelId = channelId;
      // Index the provider by channelId so PubSub events can be routed to it
      channelProviderIndex.set(channelId, provider);
      await config.db.collection('api_tokens').updateOne(
        { tokenHash: tokenDoc.tokenHash },
        { $set: { channelId } },
      );
    },
    resolvePermission: config.resolvePermission,
  });

  providerCache.set(tokenDoc.tokenHash, provider);

  // If the token already has a channelId (reconnect), index it immediately
  // so PubSub events for that channel route to this provider.
  if (tokenDoc.channelId) {
    channelProviderIndex.set(tokenDoc.channelId, provider);
  }

  return provider;
}

/**
 * Feed a PubSub channel event to the terminal provider that owns that channel.
 * Called from server-bootstrap when PubSubService broadcasts to `channel:{id}`.
 *
 * This is the bridge between Teros's internal broadcast system and the
 * Even Terminal SSE event stream — without it, G2 Terminal sessions never
 * receive streaming text, tool calls, or permission requests.
 */
export function feedChannelEvent(channelId: string, event: Record<string, unknown>): void {
  const provider = channelProviderIndex.get(channelId);
  if (provider) {
    provider.onChannelEvent(channelId, event);
  }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export function createTerminalRoutes(config: TerminalRoutesConfig) {
  const { db } = config;

  /**
   * Resolve a G2 token from the request. Returns the token doc or null
   * (and sends 401). Uses ?token= query param or Authorization: Bearer.
   */
  async function resolveToken(
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<G2Token | null> {
    const header = req.headers['authorization'];
    const rawToken = header?.startsWith('Bearer ')
      ? header.slice(7).trim()
      : url.searchParams.get('token');

    if (!rawToken) {
      sendJson(res, 401, { error: 'Unauthorized — missing token' });
      return null;
    }

    // Unknown token, or its user is deleted/suspended → 401 (touches lastUsedAt)
    const tokenDoc = (await resolveApiToken(db, rawToken)) as G2Token | null;
    if (!tokenDoc) {
      sendJson(res, 401, { error: 'Unauthorized — invalid token' });
      return null;
    }

    return tokenDoc;
  }

  return async function handleTerminalRoute(
    req: IncomingMessage,
    res: ServerResponse,
    fullUrl: string,
  ): Promise<boolean> {
    const method = req.method || 'GET';
    const url = new URL(fullUrl, 'http://localhost');
    const { pathname } = url;

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      });
      res.end();
      return true;
    }

    // ── Health check (no auth) ──────────────────────────────────────────────
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true, provider: 'teros' });
      return true;
    }

    // ── Root — serve a simple status page ───────────────────────────────────
    if (pathname === '/' || pathname === '') {
      sendJson(res, 200, {
        service: 'teros-terminal',
        version: '1.0.0',
        endpoints: ['/api/prompt', '/api/events', '/api/sessions', '/api/info'],
      });
      return true;
    }

    // Only handle /api/* paths
    if (!pathname.startsWith('/api/')) {
      return false;
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    const tokenDoc = await resolveToken(url, req, res);
    if (!tokenDoc) return true;

    const provider = getOrCreateProvider(config, tokenDoc);

    // ── SSE event stream ─────────────────────────────────────────────────────
    if (pathname === '/api/events' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId' query parameter" });
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(':ok\n\n');

      const needReplay = url.searchParams.get('needReplay') === 'true';
      const remove = addClient(sessionId, res, needReplay);

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        try {
          res.write(':heartbeat\n\n');
        } catch {
          clearInterval(heartbeat);
          remove();
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(heartbeat);
        remove();
      });

      return true;
    }

    // ── REST endpoints ───────────────────────────────────────────────────────
    const body = method === 'POST' ? await readBody(req) : {};

    // GET /api/sessions — list sessions
    if (pathname === '/api/sessions' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 10;
      const cwd = url.searchParams.get('cwd') || undefined;
      const sessions = await provider.listSessions(limit, cwd);
      // Fill in status for sessions that don't have it
      await Promise.all(
        sessions.slice(0, 10).map(async (s, i) => {
          if (!s.status) {
            sessions[i].status = await provider.getSessionStatus(s.id);
          }
        }),
      );
      sendJson(res, 200, { sessions });
      return true;
    }

    // GET /api/info — provider info
    if (pathname === '/api/info' && method === 'GET') {
      sendJson(res, 200, await provider.getInfo());
      return true;
    }

    // GET /api/update-check — version check stub
    if (pathname === '/api/update-check' && method === 'GET') {
      sendJson(res, 200, {
        packageName: 'teros-terminal',
        currentVersion: '1.0.0',
        newestVersion: null,
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      });
      return true;
    }

    // GET /api/metrics — metrics stub
    if (pathname === '/api/metrics' && method === 'GET') {
      sendJson(res, 200, { codex: { subscribedSessions: [] } });
      return true;
    }

    // POST /api/codex/ensure-app-server — codex stub
    if (pathname === '/api/codex/ensure-app-server' && method === 'POST') {
      sendJson(res, 200, { started: false });
      return true;
    }

    // POST /api/prompt — send a prompt
    if (pathname === '/api/prompt' && method === 'POST') {
      const { text, sessionId, cwd } = body;
      console.log(
        `[Terminal] prompt session=${sessionId ?? '(new)'} text=${JSON.stringify((text ?? '').slice(0, 80))}`,
      );
      if (!text || typeof text !== 'string') {
        sendJson(res, 400, { error: "Missing 'text' field" });
        return true;
      }
      const result = await provider.prompt(sessionId, text, cwd);
      sendJson(res, 202, {
        ok: true,
        sessionId: result.sessionId,
        provider: result.provider,
      });
      return true;
    }

    // POST /api/permission-response — respond to permission request
    if (pathname === '/api/permission-response' && method === 'POST') {
      const { sessionId, decision } = body;
      console.log(
        `[Terminal] permission-response session=${sessionId ?? '(none)'} decision=${decision ?? 'deny'}`,
      );
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId'" });
        return true;
      }
      if (!provider.getStatus(sessionId)) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      provider.respondPermission(sessionId, decision || 'deny').catch((err) => {
        console.error(`[Terminal] respondPermission error: ${err?.message ?? err}`);
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    // POST /api/question-response — respond to user question
    if (pathname === '/api/question-response' && method === 'POST') {
      const { sessionId, answer } = body;
      console.log(
        `[Terminal] question-response session=${sessionId ?? '(none)'} answer=${JSON.stringify((answer ?? 'skip').slice(0, 80))}`,
      );
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId'" });
        return true;
      }
      if (!provider.getStatus(sessionId)) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      provider.respondQuestion(sessionId, answer || 'skip');
      sendJson(res, 200, { ok: true });
      return true;
    }

    // POST /api/interrupt — interrupt running turn
    if (pathname === '/api/interrupt' && method === 'POST') {
      const { sessionId } = body;
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId'" });
        return true;
      }
      if (!provider.getStatus(sessionId)) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      provider.interrupt(sessionId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    // GET /api/status — session status
    if (pathname === '/api/status' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId'" });
        return true;
      }
      const status = provider.getStatus(sessionId);
      if (!status) {
        sendJson(res, 404, { error: 'Session not found' });
        return true;
      }
      sendJson(res, 200, {
        state: status.state,
        sessionId,
        provider: status.provider,
      });
      return true;
    }

    // GET /api/messages — buffered messages
    if (pathname === '/api/messages' && method === 'GET') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        sendJson(res, 400, { error: "Missing 'sessionId'" });
        return true;
      }
      const after = parseInt(url.searchParams.get('after') ?? '0', 10) || 0;
      const status = provider.getStatus(sessionId);
      sendJson(res, 200, {
        messages: getMessages(sessionId, after),
        state: status?.state ?? 'idle',
        sessionId,
        provider: status?.provider ?? 'claude',
      });
      return true;
    }

    // GET /api/sessions/:id/history — conversation history
    const histMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (histMatch && method === 'GET') {
      const id = decodeURIComponent(histMatch[1]);
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') ?? '10', 10) || 10,
        50,
      );
      const history = await provider.getHistory(id, limit);
      sendJson(res, 200, { history });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  };
}
