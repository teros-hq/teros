/**
 * Teros Container Agent — entrypoint
 *
 * Standalone daemon that owns all Docker operations for MCA containers. The
 * Teros core talks to it over HTTP (CONTAINER_PROVIDER=remote →
 * RemoteContainerBackend) and needs no Docker socket of its own.
 *
 * Run under pm2 as `teros-container-agent` (see ecosystem.config.cjs), or:
 *   CONTAINER_AGENT_TOKEN=... npx tsx src/container-agent.ts
 *
 * Environment:
 *   CONTAINER_AGENT_TOKEN  (required) shared bearer token with the core
 *   CONTAINER_AGENT_PORT   listen port                    (default 10011)
 *   CONTAINER_AGENT_HOST   listen interface               (default 127.0.0.1)
 *   AGENT_ID               identity in /health and status (default hostname)
 *   MCA_BASE_PATH          (required) mcas/ directory, as in the backend
 *   BACKEND_PORT           core port for MCA callback URLs (default 3000)
 *   MCA_CONTAINER_CPUS / MCA_CONTAINER_MEMORY_MB / MCA_HOST_GATEWAY as usual
 */

import { config as dotenvConfig } from 'dotenv';
import { hostname } from 'os';
import { dirname, resolve } from 'path';

// Same .env layering as src/config.ts: package-local first (wins), repo root
// second. Derived from the entrypoint path (works in both CJS and ESM — tsx
// runs this file as ESM, where __dirname does not exist).
const entryDir = dirname(resolve(process.argv[1] ?? '.'));
dotenvConfig({ path: resolve(entryDir, '..', '.env') });
dotenvConfig({ path: resolve(entryDir, '..', '..', '..', '.env') });

import { createContainerAgentServer } from './services/container-agent-server';
import { createDockerContainerBackend } from './services/docker-backend-factory';
import { execDocker } from './services/docker-container-backend';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[ContainerAgent] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const token = requireEnv('CONTAINER_AGENT_TOKEN');
const mcaBasePath = resolve(requireEnv('MCA_BASE_PATH'));
const backendPort = parseInt(process.env.BACKEND_PORT || '3000', 10);
const port = parseInt(process.env.CONTAINER_AGENT_PORT || '10011', 10);
const host = process.env.CONTAINER_AGENT_HOST || '127.0.0.1';
const agentId = process.env.AGENT_ID || hostname();

const backend = createDockerContainerBackend({ mcaBasePath, backendPort });

/** Live mca-* containers on this agent's Docker daemon (for GET /v1/status). */
async function listContainers(): Promise<Array<{ name: string; status: string }>> {
  const result = await execDocker(
    ['ps', '--filter', 'name=^mca-', '--format', '{{.Names}}\t{{.Status}}'],
    { timeoutMs: 15_000 },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, ...status] = line.split('\t');
      return { name, status: status.join(' ') };
    });
}

const server = createContainerAgentServer({ backend, token, agentId, listContainers });

server.listen(port, host, () => {
  console.log(`[ContainerAgent] ${agentId} listening on ${host}:${port} (mcas: ${mcaBasePath})`);
  // pm2 wait_ready support
  process.send?.('ready');
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ContainerAgent] ${signal} received — closing (containers keep running)`);
  server.close(() => process.exit(0));
  // Containers are intentionally left running: the core decides their
  // lifecycle; an agent restart must be invisible to running MCAs.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
