/**
 * Container Agent — HTTP server
 *
 * Thin HTTP facade over an IContainerBackend, run as its own daemon
 * (src/container-agent.ts) so the Teros core can operate containers without
 * any Docker access of its own (CONTAINER_PROVIDER=remote →
 * RemoteContainerBackend). Phase 0-1 of TWO-HOST-SEPARATION-PLAN.md.
 *
 * Multi-agent ready: the agent holds no knowledge of the core or of sibling
 * agents. Scaling to N agents is purely a core-side concern (a routing
 * IContainerBackend + placement policy — see SCALABILITY-ANALYSIS.md §4-5);
 * AGENT_ID and GET /v1/status exist so that layer can attribute containers
 * and read capacity.
 *
 * Security: bearer-token auth (timing-safe) on everything except /health.
 * Bind it to loopback or a private interface — never a public one.
 */

import { timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { ContainerStartOptions, IContainerBackend } from './container-backend';
import { assertSafeContainerName } from './docker-container-backend';

const MAX_BODY_BYTES = 256 * 1024;

export interface ContainerAgentServerConfig {
  backend: IContainerBackend;
  /** Shared bearer token. The entrypoint refuses to boot without one. */
  token: string;
  /** Identifies this agent in /health, /v1/status and logs (e.g. hostname). */
  agentId: string;
  /**
   * Lists containers this agent currently runs, for /v1/status. Optional —
   * injected by the entrypoint (docker ps) so this module stays backend-agnostic.
   */
  listContainers?: () => Promise<Array<{ name: string; status: string }>>;
}

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing or invalid field: ${field}`);
  }
  return value;
}

export function createContainerAgentServer(cfg: ContainerAgentServerConfig): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      const url = new URL(req.url ?? '/', 'http://agent.internal');

      // Unauthenticated liveness probe (no state exposed beyond identity).
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(200, { status: 'ok', agentId: cfg.agentId });
      }

      const auth = req.headers.authorization ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!cfg.token || !provided || !tokenMatches(cfg.token, provided)) {
        return send(401, { error: 'unauthorized' });
      }

      if (req.method === 'POST' && url.pathname === '/v1/start') {
        const body = await readJsonBody(req);
        const mcaId = requireString(body.mcaId, 'mcaId');
        const containerName = requireString(body.containerName, 'containerName');
        const callbackToken = requireString(body.callbackToken, 'callbackToken');
        // The backend validates too — defense in depth at the trust boundary.
        assertSafeContainerName(containerName);
        const info = await cfg.backend.start(
          mcaId,
          containerName,
          callbackToken,
          body.options as ContainerStartOptions | undefined,
        );
        return send(200, info);
      }

      if (req.method === 'POST' && url.pathname === '/v1/stop') {
        const body = await readJsonBody(req);
        const containerName = requireString(body.containerName, 'containerName');
        assertSafeContainerName(containerName);
        await cfg.backend.stop(containerName);
        return send(200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/v1/running') {
        const name = url.searchParams.get('name') ?? '';
        assertSafeContainerName(name);
        const running = await cfg.backend.isActuallyRunning(name);
        return send(200, { running });
      }

      if (req.method === 'POST' && url.pathname === '/v1/cleanup-orphans') {
        await cfg.backend.cleanupOrphans();
        return send(200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/v1/allocate-port') {
        const port = await cfg.backend.allocatePort();
        return send(200, { port });
      }

      if (req.method === 'POST' && url.pathname === '/v1/release-port') {
        const body = await readJsonBody(req);
        if (!Number.isInteger(body.port)) throw new Error('missing or invalid field: port');
        cfg.backend.releasePort(body.port);
        return send(200, { ok: true });
      }

      // Capacity/attribution snapshot for ops and the future placement layer.
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        const containers = cfg.listContainers ? await cfg.listContainers() : [];
        return send(200, { agentId: cfg.agentId, containers, count: containers.length });
      }

      return send(404, { error: 'not found' });
    } catch (error: any) {
      const message = error?.message ?? 'internal error';
      // Client errors (validation) → 400; anything else → 500 with the message
      // so RemoteContainerBackend can surface it (parity with local errors).
      const status = /missing or invalid|Invalid container name|too large|invalid JSON/.test(message)
        ? 400
        : 500;
      return send(status, { error: message });
    }
  });
}
