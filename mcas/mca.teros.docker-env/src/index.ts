#!/usr/bin/env npx tsx

/**
 * mca.teros.docker-env — Ephemeral Docker Environment Manager
 *
 * Manages per-user ephemeral Docker environments backed by docker-compose.
 * Each environment is:
 *   - Launched via docker-compose up from a local workspace directory (localPath)
 *   - Isolated in its own Docker network: teros-env-{userId}-{envId}
 *   - Accessible via a unique URL ({envId}.envs.teros.ai)
 *   - Destroyed on demand or after TTL
 *
 * Phase 1 (PoC): Uses docker socket directly — suitable for trusted pre-prod.
 * Phase 2 (MVP): Will use Tecnativa docker-socket-proxy for hardened isolation.
 *
 * Tools:
 *   env-create   — Register env, launch docker-compose up in background, return immediately
 *   env-status   — Poll environment status (creating/building/running/stopped/error)
 *   env-exec     — Run a command inside the environment
 *   env-logs     — Fetch recent logs from a service
 *   env-list     — List environments (shows intermediate states)
 *   env-restart  — Restart a running/stopped environment
 *   env-destroy  — docker-compose down + cleanup
 *
 * State machine:
 *   creating → building → running
 *   creating → building → error
 *   running  → stopped (env-destroy or container crash)
 */

import { McaServer } from '@teros/mca-sdk';
import { exec } from 'child_process';
import { existsSync, statSync, appendFileSync, readFileSync, mkdirSync } from 'fs';
import { promisify } from 'util';
import { join } from 'path';
import * as http from 'http';
import { MongoClient, Collection } from 'mongodb';

const execAsync = promisify(exec);

// ============================================================================
// CONSTANTS
// ============================================================================

/** Docker socket path — direct mount for PoC (Phase 1) */
const DOCKER_HOST = process.env.DOCKER_HOST || 'unix:///var/run/docker.sock';

/** Base domain for public URLs */
const BASE_DOMAIN = process.env.DOCKER_ENV_DOMAIN || 'teros.ai';

/**
 * Real host path of the workspace volume, as seen by the Docker daemon.
 * Set to "/workspace" in pre-prod. In prod the mca-manager injects the real path.
 * REQUIRED — env-create will fail with a clear error if not set.
 */
const WORKSPACE_HOST_PATH = process.env.WORKSPACE_HOST_PATH;

/**
 * Directory for build log files (inside the MCA container).
 * Each env gets its own log file: {LOG_DIR}/{envId}.log
 */
const LOG_DIR = process.env.DOCKER_ENV_LOG_DIR || '/tmp/teros-env-logs';

// Ensure log directory exists at startup
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

// ============================================================================
// MONGODB
// ============================================================================

let envsCollection: Collection | null = null;

async function initMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DATABASE;
  if (!uri || !dbName) {
    console.error('⚠️  MONGODB_URI or MONGODB_DATABASE not set — env state will NOT be persisted');
    return;
  }
  try {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    envsCollection = db.collection('docker_envs');
    // Ensure indexes for efficient queries
    await envsCollection.createIndex({ envId: 1 }, { unique: true });
    await envsCollection.createIndex({ userId: 1 });
    console.error('✅ MongoDB connected — docker_envs collection ready');
  } catch (err: any) {
    console.error(`❌ MongoDB connection failed: ${err.message} — env state will NOT be persisted`);
    envsCollection = null;
  }
}

/**
 * Upsert an EnvRecord into MongoDB (best-effort, non-blocking on failure).
 */
async function mongoUpsert(record: EnvRecord): Promise<void> {
  if (!envsCollection) return;
  try {
    await envsCollection.updateOne(
      { envId: record.envId },
      { $set: { ...record, updatedAt: new Date().toISOString() } },
      { upsert: true },
    );
  } catch (err: any) {
    console.error(`⚠️  mongoUpsert failed for env ${record.envId}: ${err.message}`);
  }
}

/**
 * Delete an EnvRecord from MongoDB.
 */
async function mongoDelete(envId: string): Promise<void> {
  if (!envsCollection) return;
  try {
    await envsCollection.deleteOne({ envId });
  } catch (err: any) {
    console.error(`⚠️  mongoDelete failed for env ${envId}: ${err.message}`);
  }
}

/** Max log lines to return from docker compose logs */
const MAX_LOG_LINES = 200;

/** Max exec output size */
const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

/** Max build log lines to include in env-status response */
const MAX_BUILD_LOG_LINES = 100;

/**
 * Caddy Admin API proxy URL.
 * A Node.js proxy (caddy-api-proxy.service) listens on 172.17.0.1:2020 and
 * forwards to 127.0.0.1:2019 with the correct Host header so Caddy accepts it.
 * This allows the MCA container to call the Caddy admin API.
 */
const CADDY_API_URL = process.env.CADDY_API_URL || 'http://host.docker.internal:2020';

// ============================================================================
// TYPES
// ============================================================================

type EnvStatus = 'creating' | 'building' | 'running' | 'stopped' | 'error';

interface EnvRecord {
  envId: string;
  userId: string;
  localPath: string;
  hostPath: string;
  composeFile: string;
  networkName: string;
  projectName: string;
  workdir: string;
  status: EnvStatus;
  createdAt: string;
  updatedAt: string;
  services: string[];
  urls: Record<string, string>;
  error?: string;
  buildLogPath?: string;
}

// ============================================================================
// PATH HELPERS
// ============================================================================

/**
 * Translate a container-side /workspace path to the real host path for Docker.
 */
function resolveHostPath(localPath: string): string {
  if (!WORKSPACE_HOST_PATH) {
    throw new Error(
      'WORKSPACE_HOST_PATH is not set. This is required for docker-env to resolve workspace paths.',
    );
  }
  if (localPath.startsWith('/workspace')) {
    const relative = localPath.slice('/workspace'.length);
    return WORKSPACE_HOST_PATH.replace(/\/$/, '') + relative;
  }
  return localPath;
}

// ============================================================================
// ID HELPERS
// ============================================================================

function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 20);
}

function buildProjectName(userId: string, envId: string): string {
  return `teros-${sanitizeId(userId)}-${envId}`;
}

function buildNetworkName(userId: string, envId: string): string {
  return `teros-env-${sanitizeId(userId)}-${envId}`;
}

function assertOwnership(env: EnvRecord, userId: string): void {
  if (env.userId !== userId) {
    throw new Error(`Access denied: environment ${env.envId} does not belong to this user`);
  }
}

// ============================================================================
// DOCKER HELPERS
// ============================================================================

async function runCompose(
  workdir: string,
  composeFile: string,
  projectName: string,
  args: string,
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  const cmd = `DOCKER_HOST="${DOCKER_HOST}" docker compose -f "${composeFile}" -p "${projectName}" ${args}`;
  try {
    const result = await execAsync(cmd, {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || err.message || 'unknown error' };
  }
}

async function getComposeServices(workdir: string, composeFile: string, projectDir?: string): Promise<string[]> {
  try {
    const projectDirArg = projectDir ? `--project-directory "${projectDir}"` : '';
    const envFileArg = existsSync(join(workdir, '.env')) ? `--env-file "${join(workdir, '.env')}"` : '';
    const { stdout } = await execAsync(
      `DOCKER_HOST="${DOCKER_HOST}" docker compose -f "${composeFile}" ${projectDirArg} ${envFileArg} config --services`,
      { cwd: workdir, timeout: 15_000,  },
    );
    return stdout.trim().split('\n').filter((s) => s.trim());
  } catch {
    return [];
  }
}

async function buildUrlMap(
  projectName: string,
  envId: string,
  services: string[],
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const svc of services) {
    urls[svc] = `https://${envId}.${BASE_DOMAIN}`;
  }
  try {
    const { stdout } = await execAsync(
      `DOCKER_HOST="${DOCKER_HOST}" docker compose -p "${projectName}" ps --format json`,
      { timeout: 10_000,  },
    );
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      try {
        const container = JSON.parse(line);
        const svcName = container.Service || container.Name;
        if (!svcName) continue;
        for (const pub of container.Publishers || []) {
          if (pub.PublishedPort && pub.PublishedPort > 0) {
            urls[`${svcName}_local`] = `http://localhost:${pub.PublishedPort}`;
            break;
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* port detection is best-effort */ }
  return urls;
}

async function isAnyContainerRunning(projectName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `DOCKER_HOST="${DOCKER_HOST}" docker compose -p "${projectName}" ps --format json`,
      { timeout: 10_000,  },
    );
    return stdout.trim().split('\n').filter(Boolean).some((l) => {
      try { return JSON.parse(l).State === 'running'; } catch { return false; }
    });
  } catch {
    return false;
  }
}

// ============================================================================
// BUILD LOG HELPERS
// ============================================================================

function appendBuildLog(logPath: string, line: string): void {
  try { appendFileSync(logPath, line + '\n', 'utf-8'); } catch { /* best-effort */ }
}

function readLastLines(filePath: string, n: number): string[] {
  try {
    return readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

// ============================================================================
// CADDY ROUTING HELPERS
// ============================================================================

/**
 * Make an HTTP request to the Caddy Admin API proxy.
 * Returns { status, body } or throws on network error.
 */
function caddyRequest(method: string, path: string, body?: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CADDY_API_URL);
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: parseInt(url.port || '80', 10),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Register a Caddy reverse-proxy route for an ephemeral environment.
 * Route ID: route_env_{envId}  (used for deletion)
 * Matches: {envId}.{BASE_DOMAIN}
 * Upstream: containerIp:port (direct container IP, reachable from host via bridge)
 *
 * Routes are registered in srv_envs (port 2443, HTTPS with automatic cert management).
 * Nginx does TCP passthrough on port 443 → Caddy srv_envs on port 2443.
 * Caddy automatically manages SSL certificates via Let's Encrypt for each hostname.
 *
 * The catch-all 404 route is always kept at the end of the routes list.
 */
async function registerCaddyRoute(envId: string, containerIp: string, port: number = 3000): Promise<void> {
  const routeId = `route_env_${envId}`;
  const hostname = `${envId}.${BASE_DOMAIN}`;
  const upstream = `${containerIp}:${port}`;

  const CATCH_ALL = { handle: [{ body: 'Route not configured', handler: 'static_response', status_code: 404 }] };

  // Step 1: Get current routes from srv_envs (HTTPS server on :2443)
  const listResult = await caddyRequest('GET', '/config/apps/http/servers/srv0/routes');
  if (listResult.status >= 300) {
    throw new Error(`Caddy GET routes failed (${listResult.status}): ${listResult.body}`);
  }

  let routes: any[] = [];
  try { routes = JSON.parse(listResult.body); } catch { routes = []; }

  // Step 2: Remove catch-all if present (last route with no @id and no match.host)
  const hasCatchAll = routes.length > 0 &&
    !routes[routes.length - 1]['@id'] &&
    !routes[routes.length - 1].match;

  if (hasCatchAll) {
    const lastIndex = routes.length - 1;
    const delResult = await caddyRequest('DELETE', `/config/apps/http/servers/srv0/routes/${lastIndex}`);
    if (delResult.status >= 300 && delResult.status !== 404) {
      throw new Error(`Caddy DELETE catch-all failed (${delResult.status}): ${delResult.body}`);
    }
  }

  // Step 3: Add the new env route (POST appends to the list)
  const route = {
    '@id': routeId,
    match: [{ host: [hostname] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: upstream }],
        headers: {
          request: {
            set: {
              'X-Forwarded-Host': ['{http.request.host}'],
            },
          },
        },
      },
    ],
  };

  const addResult = await caddyRequest('POST', '/config/apps/http/servers/srv0/routes', route);
  if (addResult.status >= 300) {
    throw new Error(`Caddy route registration failed (${addResult.status}): ${addResult.body}`);
  }

  // Step 4: Re-add catch-all at the end
  if (hasCatchAll) {
    const reAddResult = await caddyRequest('POST', '/config/apps/http/servers/srv0/routes', CATCH_ALL);
    if (reAddResult.status >= 300) {
      throw new Error(`Caddy re-add catch-all failed (${reAddResult.status}): ${reAddResult.body}`);
    }
  }
}



/**
 * Remove the Caddy route for an ephemeral environment by its ID.
 */
async function removeCaddyRoute(envId: string): Promise<void> {
  const routeId = `route_env_${envId}`;
  const result = await caddyRequest('DELETE', `/id/${routeId}`);
  // 200 = deleted, 404 = already gone — both are fine
  if (result.status >= 300 && result.status !== 404) {
    throw new Error(`Caddy route removal failed (${result.status}): ${result.body}`);
  }
}

/**
 * Get the first container IP for a given compose project.
 * Tries docker compose ps to find container names, then docker inspect for IPs.
 * Returns null if no running container found.
 */
async function getContainerIp(projectName: string): Promise<string | null> {
  try {
    // Get container names for this project
    const { stdout } = await execAsync(
      `DOCKER_HOST="${DOCKER_HOST}" docker compose -p "${projectName}" ps --format json`,
      { timeout: 10_000 },
    );
    const containers: string[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      try {
        const c = JSON.parse(line);
        if (c.Name) containers.push(c.Name);
      } catch { /* skip */ }
    }
    if (containers.length === 0) return null;

    // Inspect the first container and extract its IP
    for (const name of containers) {
      try {
        const { stdout: inspectOut } = await execAsync(
          `DOCKER_HOST="${DOCKER_HOST}" docker inspect "${name}" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
          { timeout: 10_000 },
        );
        const ip = inspectOut.trim().split('\n')[0]?.trim();
        if (ip && ip.match(/^\d+\.\d+\.\d+\.\d+$/)) return ip;
      } catch { /* try next */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// STORE HELPERS
// These use context.getData / context.setData directly (no wrapper recursion).
// ============================================================================

/**
 * Module-level map populated during startup rehydration.
 * On the first loadEnvsMap call, these records are merged into the context store.
 */
const rehydratedEnvs: Record<string, EnvRecord> = {};

async function loadEnvsMap(context: any): Promise<Record<string, EnvRecord>> {
  const { value } = await context.getData('envs');
  const stored: Record<string, EnvRecord> = value || {};

  // Merge rehydrated envs from MongoDB on first call (rehydratedEnvs drains itself)
  if (Object.keys(rehydratedEnvs).length > 0) {
    let merged = false;
    for (const [envId, record] of Object.entries(rehydratedEnvs)) {
      if (!stored[envId]) {
        stored[envId] = record;
        merged = true;
      }
      delete rehydratedEnvs[envId];
    }
    if (merged) {
      // Persist the merged state back to the context store
      await context.setData('envs', stored);
    }
  }

  return stored;
}

async function saveEnvsMap(context: any, envsMap: Record<string, EnvRecord>): Promise<void> {
  await context.setData('envs', envsMap);
}

// ============================================================================
// BACKGROUND BUILD
// ============================================================================

/**
 * Run docker-compose up --build in the background.
 * State transitions: creating → building → running | error
 *
 * Called without await so it runs asynchronously after env-create returns.
 * Uses persistFn callback to update the store from background.
 */
async function runBuildInBackground(params: {
  envId: string;
  workdir: string;
  composeHostPath: string;
  projectHostDir: string;
  projectName: string;
  networkName: string;
  envVarArgs: string;
  timeoutSecs: number;
  buildLogPath: string;
  persistFn: (patch: Partial<EnvRecord>) => Promise<void>;
}): Promise<void> {
  const { envId, workdir, composeHostPath, projectHostDir, projectName, networkName, envVarArgs, timeoutSecs, buildLogPath, persistFn } = params;

  // Phase 1: Create isolated network
  try {
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Creating Docker network: ${networkName}`);
    await execAsync(
      `DOCKER_HOST="${DOCKER_HOST}" docker network create --driver bridge "${networkName}" 2>/dev/null || true`,
      { timeout: 15_000,  },
    );
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Network ready`);
  } catch (err: any) {
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Network warning: ${err.message}`);
  }

  // Phase 2: Transition to 'building'
  await persistFn({ status: 'building', updatedAt: new Date().toISOString() });
  appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Starting docker-compose up --build`);

  // Phase 3: Run docker-compose up -d --build
  // --project-directory uses the host-side path so the Docker daemon resolves relative volume mounts correctly.
  // -f uses the container-side path so the docker-compose CLI can read the file.
  // --env-file uses the container-side path so docker compose CLI can read the .env file for variable interpolation.
  const envFileArg = existsSync(join(workdir, '.env')) ? `--env-file "${join(workdir, '.env')}"` : '';
  // Note: --project-directory is intentionally omitted here. When docker compose CLI runs inside
  // the MCA container, -f points to the container-side path (/workspace/...) which the Docker
  // daemon resolves correctly for build contexts. Adding --project-directory with the host-side
  // path causes "unable to prepare context" errors because the daemon cannot find that path.
  const cmd = `DOCKER_HOST="${DOCKER_HOST}" docker compose -f "${composeHostPath}" ${envFileArg} -p "${projectName}" up -d --build --remove-orphans ${envVarArgs}`;
  let buildFailed = false;
  let buildError = '';
  let buildStdout = '';
  let buildStderr = '';

  try {
    const result = await execAsync(cmd, {
      cwd: workdir,
      timeout: timeoutSecs * 1000,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    buildStdout = result.stdout || '';
    buildStderr = result.stderr || '';
  } catch (err: any) {
    buildFailed = true;
    buildStdout = err.stdout || '';
    buildStderr = err.stderr || err.message || 'unknown error';
    buildError = buildStderr;
  }

  // Append build output to log
  for (const line of (buildStdout + '\n' + buildStderr).split('\n')) {
    if (line.trim()) appendBuildLog(buildLogPath, line);
  }

  if (buildFailed) {
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Build FAILED`);
    await persistFn({ status: 'error', error: buildError.slice(0, 2000), updatedAt: new Date().toISOString() });
    return;
  }

  // Phase 4: Verify containers are running
  appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Verifying containers...`);
  const hasRunning = await isAnyContainerRunning(projectName);

  if (!hasRunning && buildStderr.includes('Error')) {
    const errMsg = `docker-compose up completed but no containers are running. stderr: ${buildStderr.slice(0, 1000)}`;
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] ERROR: ${errMsg}`);
    await persistFn({ status: 'error', error: errMsg, updatedAt: new Date().toISOString() });
    return;
  }

  // Phase 5: Detect services + URLs
  appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Detecting services and URLs...`);
  let services: string[] = [];
  let urls: Record<string, string> = {};
  try {
    services = await getComposeServices(workdir, composeHostPath, projectHostDir);
    urls = await buildUrlMap(projectName, envId, services);
  } catch { /* best-effort */ }

  // Phase 6: Register Caddy route (container IP → {envId}.domain)
  const publicUrl = `https://${envId}.${BASE_DOMAIN}`;
  try {
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Detecting container IP...`);
    const containerIp = await getContainerIp(projectName);
    if (containerIp) {
      appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Container IP: ${containerIp} — registering Caddy route`);
      await registerCaddyRoute(envId, containerIp, 3000);
      appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Caddy route registered: ${publicUrl} → ${containerIp}:3000`);
      appendBuildLog(buildLogPath, `[${new Date().toISOString()}] SSL cert will be issued automatically by Caddy via Let's Encrypt`);
      // Set public URL for all services
      for (const svc of services) {
        urls[svc] = publicUrl;
      }
      if (services.length === 0) urls['web'] = publicUrl;
    } else {
      appendBuildLog(buildLogPath, `[${new Date().toISOString()}] WARN: Could not detect container IP — skipping Caddy route`);
    }
  } catch (err: any) {
    appendBuildLog(buildLogPath, `[${new Date().toISOString()}] WARN: Caddy route registration failed: ${err.message}`);
  }

  appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Environment ready. Services: ${services.join(', ')} — URL: ${publicUrl} (${envId}.${BASE_DOMAIN})`);

  // Phase 7: Transition to 'running'
  await persistFn({ status: 'running', services, urls, updatedAt: new Date().toISOString() });
}

// ============================================================================
// MCA SERVER
// ============================================================================

const server = new McaServer({
  id: 'mca.teros.docker-env',
  name: 'Docker Environments',
  version: '1.1.0',
});

// ============================================================================
// TOOL: env-create
// ============================================================================

server.tool('env-create', {
  description:
    'Launch a docker-compose stack from a local workspace directory as an ephemeral environment. Returns immediately with envId and status "creating" — the build happens in the background. Use env-status to poll until status is "running". The environment is isolated in its own Docker network scoped to your user.',
  parameters: {
    type: 'object',
    properties: {
      localPath: {
        type: 'string',
        description: 'Absolute path to the local workspace directory containing the docker-compose file. Example: /workspace/my-project',
      },
      composeFile: {
        type: 'string',
        description: 'Path to docker-compose file relative to localPath (default: docker-compose.yml)',
        default: 'docker-compose.yml',
      },
      envVars: {
        type: 'object',
        description: 'Additional environment variables to inject into the compose stack (key-value pairs)',
        additionalProperties: { type: 'string' },
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds for docker-compose up --build (default: 300)',
        default: 300,
      },
    },
    required: ['localPath'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const localPath = args.localPath as string;
    const composeFile = (args.composeFile as string) || 'docker-compose.yml';
    const envVars = (args.envVars as Record<string, string>) || {};
    const timeoutSecs = (args.timeout as number) || 300;

    if (!localPath) throw new Error('localPath is required');

    // Translate /workspace path to real host path
    let hostPath: string;
    try {
      hostPath = resolveHostPath(localPath);
    } catch (err: any) {
      return { success: false, error: err.message, hint: 'WORKSPACE_HOST_PATH must be injected by the backend.' };
    }

    // Validate localPath (accessible inside the container via the mounted workspace volume)
    if (!existsSync(localPath)) {
      return { success: false, error: `Directory not found: ${localPath}`, hint: 'Make sure the localPath exists in the workspace volume.' };
    }
    const stat = statSync(localPath);
    if (!stat.isDirectory()) {
      return { success: false, error: `localPath is not a directory: ${localPath}` };
    }

    // Validate compose file (using localPath since it's mounted in the container)
    // Use join() to correctly handle composeFile with subdirectories (e.g. "docker/docker-compose.test.yml")
    const composePath = join(localPath, composeFile);
    if (!existsSync(composePath)) {
      return { success: false, error: `Compose file not found: ${composePath}`, hint: 'Check the composeFile parameter. It should be relative to localPath (e.g. "docker-compose.yml" or "docker/docker-compose.test.yml").' };
    }

    // Generate IDs and paths
    const envId = shortId();
    const projectName = buildProjectName(userId, envId);
    const networkName = buildNetworkName(userId, envId);
    // workdir/composeHostPath use localPath (container-side) since docker-compose CLI runs inside the MCA container.
    // hostPath is only used as --project-directory so the Docker daemon resolves relative volume bind mounts correctly.
    const workdir = localPath;
    // composeHostPath uses localPath (container-side) since docker-compose CLI runs inside the MCA
    // container and needs to read the file. The Docker daemon gets --project-directory (hostPath)
    // to resolve relative build contexts and volume mounts correctly.
    const composeHostPath = join(localPath, composeFile);
    const buildLogPath = join(LOG_DIR, `${envId}.log`);

    // Build env vars string
    const envVarArgs = Object.entries(envVars).map(([k, v]) => `--env "${k}=${v}"`).join(' ');

    // Register env in store with status 'creating'
    const now = new Date().toISOString();
    const envRecord: EnvRecord = {
      envId, userId, localPath, hostPath, composeFile, networkName, projectName, workdir,
      status: 'creating', createdAt: now, updatedAt: now,
      services: [], urls: {}, buildLogPath,
    };

    const envsMap = await loadEnvsMap(context);
    envsMap[envId] = envRecord;
    await saveEnvsMap(context, envsMap);
    await mongoUpsert(envRecord);

    appendBuildLog(buildLogPath, `[${now}] Environment ${envId} registered. Starting build...`);

    // persistFn: reload store, merge patch, save — used by background process
    const persistFn = async (patch: Partial<EnvRecord>): Promise<void> => {
      try {
        const currentMap = await loadEnvsMap(context);
        if (currentMap[envId]) {
          currentMap[envId] = { ...currentMap[envId], ...patch };
          await saveEnvsMap(context, currentMap);
          await mongoUpsert(currentMap[envId]);
        }
      } catch (err: any) {
        appendBuildLog(buildLogPath, `[${new Date().toISOString()}] WARN: Failed to persist state: ${err.message}`);
      }
    };

    // Fire and forget — intentionally no await
    runBuildInBackground({ envId, workdir, composeHostPath, projectHostDir: hostPath, projectName, networkName, envVarArgs, timeoutSecs, buildLogPath, persistFn })
      .catch((err) => {
        appendBuildLog(buildLogPath, `[${new Date().toISOString()}] FATAL: ${err.message}`);
        persistFn({ status: 'error', error: `Unexpected error: ${err.message}`, updatedAt: new Date().toISOString() }).catch(() => {});
      });

    return {
      success: true,
      envId,
      projectName,
      networkName,
      localPath,
      status: 'creating',
      createdAt: now,
      message: 'Environment is being created in the background.',
      hint: `Poll with env-status envId="${envId}" until status is "running" or "error"`,
    };
  },
});

// ============================================================================
// TOOL: env-status
// ============================================================================

server.tool('env-status', {
  description:
    'Get detailed status of a Docker environment. Useful for polling after env-create until the environment is "running". Returns status, URLs, services, createdAt, error (if failed), and last build log lines.',
  parameters: {
    type: 'object',
    properties: {
      envId: {
        type: 'string',
        description: 'Environment ID returned by env-create',
      },
      buildLogLines: {
        type: 'number',
        description: `Number of recent build log lines to include (default: 20, max: ${MAX_BUILD_LOG_LINES})`,
        default: 20,
      },
    },
    required: ['envId'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const envId = args.envId as string;
    const logLines = Math.min((args.buildLogLines as number) || 20, MAX_BUILD_LOG_LINES);

    if (!envId) throw new Error('envId is required');

    const envsMap = await loadEnvsMap(context);
    if (!envsMap[envId]) {
      throw new Error(`Environment ${envId} not found. Use env-list to see active environments.`);
    }
    const env: EnvRecord = envsMap[envId];
    assertOwnership(env, userId);

    // For running/stopped, also verify live Docker status
    let liveStatus: EnvStatus | 'unknown' = env.status;
    if (env.status === 'running' || env.status === 'stopped') {
      const hasRunning = await isAnyContainerRunning(env.projectName);
      liveStatus = hasRunning ? 'running' : 'stopped';
    }

    const buildLog = env.buildLogPath ? readLastLines(env.buildLogPath, logLines) : [];

    return {
      envId: env.envId,
      status: liveStatus !== 'unknown' ? liveStatus : env.status,
      storeStatus: env.status,
      localPath: env.localPath,
      projectName: env.projectName,
      networkName: env.networkName,
      services: env.services,
      urls: env.urls,
      createdAt: env.createdAt,
      updatedAt: env.updatedAt,
      error: env.error || null,
      buildLog,
      ready: liveStatus === 'running',
    };
  },
});

// ============================================================================
// TOOL: env-exec
// ============================================================================

server.tool('env-exec', {
  description:
    'Execute a command inside a running environment. The command runs in the context of the docker-compose project. Returns stdout, stderr, and exit code.',
  parameters: {
    type: 'object',
    properties: {
      envId: { type: 'string', description: 'Environment ID returned by env-create' },
      service: { type: 'string', description: 'Name of the service/container to run the command in (as defined in docker-compose)' },
      command: { type: 'string', description: 'Command to execute inside the container (e.g. "npx playwright test --reporter=json")' },
      workdir: { type: 'string', description: 'Working directory inside the container (optional)' },
      timeout: { type: 'number', description: 'Timeout in seconds (default: 120, max: 600)', default: 120 },
    },
    required: ['envId', 'service', 'command'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const envId = args.envId as string;
    const service = args.service as string;
    const command = args.command as string;
    const workdir = args.workdir as string | undefined;
    const timeoutSecs = Math.min((args.timeout as number) || 120, 600);

    if (!envId) throw new Error('envId is required');
    if (!service) throw new Error('service is required');
    if (!command) throw new Error('command is required');

    const envsMap = await loadEnvsMap(context);
    if (!envsMap[envId]) {
      throw new Error(`Environment ${envId} not found. Use env-list to see active environments.`);
    }
    const env: EnvRecord = envsMap[envId];
    assertOwnership(env, userId);

    if (env.status === 'creating' || env.status === 'building') {
      throw new Error(`Environment ${envId} is still being built (status: ${env.status}). Use env-status to poll.`);
    }
    if (env.status !== 'running') {
      throw new Error(`Environment ${envId} is not running (status: ${env.status})`);
    }

    const workdirFlag = workdir ? `--workdir "${workdir}"` : '';
    const execCmd = `DOCKER_HOST="${DOCKER_HOST}" docker compose -p "${env.projectName}" exec -T ${workdirFlag} "${service}" sh -c ${JSON.stringify(command)}`;

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = await execAsync(execCmd, { timeout: timeoutSecs * 1000, maxBuffer: MAX_OUTPUT_BYTES,  });
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (err: any) {
      stdout = err.stdout || '';
      stderr = err.stderr || err.message || '';
      exitCode = err.code || 1;
    }

    return {
      envId, service, command, exitCode,
      stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      stderr: stderr.slice(0, 10_000),
      duration: `${Date.now() - startTime}ms`,
    };
  },
});

// ============================================================================
// TOOL: env-logs
// ============================================================================

server.tool('env-logs', {
  description: 'Fetch recent logs from a service in a running environment. Returns the last N lines of container output.',
  parameters: {
    type: 'object',
    properties: {
      envId: { type: 'string', description: 'Environment ID returned by env-create' },
      service: { type: 'string', description: 'Service name (as defined in docker-compose). Omit for all services.' },
      lines: { type: 'number', description: `Number of log lines to return (default: 50, max: ${MAX_LOG_LINES})`, default: 50 },
      timestamps: { type: 'boolean', description: 'Include timestamps in log output (default: true)', default: true },
    },
    required: ['envId'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const envId = args.envId as string;
    const service = (args.service as string) || '';
    const lines = Math.min((args.lines as number) || 50, MAX_LOG_LINES);
    const timestamps = (args.timestamps as boolean) !== false;

    if (!envId) throw new Error('envId is required');

    const envsMap = await loadEnvsMap(context);
    if (!envsMap[envId]) throw new Error(`Environment ${envId} not found.`);
    const env: EnvRecord = envsMap[envId];
    assertOwnership(env, userId);

    const tsFlag = timestamps ? '--timestamps' : '';
    const serviceArg = service ? `"${service}"` : '';
    const logsCmd = `DOCKER_HOST="${DOCKER_HOST}" docker compose -p "${env.projectName}" logs --tail="${lines}" ${tsFlag} ${serviceArg}`;

    try {
      const { stdout, stderr } = await execAsync(logsCmd, { timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES,  });
      return { envId, service: service || '(all services)', lines, logs: (stdout || stderr || '(no logs)').slice(0, MAX_OUTPUT_BYTES) };
    } catch (err: any) {
      return { envId, service: service || '(all services)', lines, logs: err.stdout || err.stderr || err.message || '(error)', error: err.message };
    }
  },
});

// ============================================================================
// TOOL: env-list
// ============================================================================

server.tool('env-list', {
  description:
    'List all environments for the current user/workspace. Shows envId, status (including intermediate states: creating, building, running, stopped, error), localPath, services, and URLs.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const userId = context.execution.userId;
    const envsMap = await loadEnvsMap(context);
    const userEnvs = Object.values(envsMap).filter((env) => env.userId === userId);

    if (userEnvs.length === 0) return { environments: [], count: 0 };

    const enriched = await Promise.all(
      userEnvs.map(async (env) => {
        let displayStatus: EnvStatus | 'unknown' = env.status;

        // For creating/building/error: trust the store (Docker may not have containers yet)
        if (env.status === 'creating' || env.status === 'building' || env.status === 'error') {
          displayStatus = env.status;
        } else {
          // For running/stopped: verify with live Docker ps
          try {
            const hasRunning = await isAnyContainerRunning(env.projectName);
            displayStatus = hasRunning ? 'running' : 'stopped';
          } catch {
            displayStatus = 'unknown' as any;
          }
        }

        return {
          envId: env.envId,
          status: displayStatus,
          localPath: env.localPath,
          services: env.services,
          urls: env.urls,
          createdAt: env.createdAt,
          updatedAt: env.updatedAt,
          projectName: env.projectName,
          error: env.error || undefined,
        };
      }),
    );

    return { environments: enriched, count: enriched.length };
  },
});

// ============================================================================
// TOOL: env-restart
// ============================================================================

server.tool('env-restart', {
  description:
    'Restart a Docker environment: stops all containers and brings them back up. Useful to reload config changes or recover from a stopped state. Returns immediately — use env-status to poll until "running".',
  parameters: {
    type: 'object',
    properties: {
      envId: { type: 'string', description: 'Environment ID to restart' },
      rebuild: {
        type: 'boolean',
        description: 'If true, rebuild images before restarting (docker-compose up --build). Default: false.',
        default: false,
      },
    },
    required: ['envId'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const envId = args.envId as string;
    const rebuild = (args.rebuild as boolean) || false;

    if (!envId) throw new Error('envId is required');

    const envsMap = await loadEnvsMap(context);
    if (!envsMap[envId]) throw new Error(`Environment ${envId} not found.`);
    const env: EnvRecord = envsMap[envId];
    assertOwnership(env, userId);

    if (env.status === 'creating' || env.status === 'building') {
      throw new Error(`Environment ${envId} is still being built (status: ${env.status}). Wait until "running" or "error".`);
    }

    const buildLogPath = env.buildLogPath || join(LOG_DIR, `${envId}.log`);
    const now = new Date().toISOString();

    // Update status to 'building' immediately
    envsMap[envId] = { ...env, status: 'building', updatedAt: now, error: undefined };
    await saveEnvsMap(context, envsMap);
    await mongoUpsert(envsMap[envId]);
    appendBuildLog(buildLogPath, `[${now}] Restarting environment ${envId} (rebuild=${rebuild})`);

    const persistFn = async (patch: Partial<EnvRecord>): Promise<void> => {
      try {
        const currentMap = await loadEnvsMap(context);
        if (currentMap[envId]) {
          currentMap[envId] = { ...currentMap[envId], ...patch };
          await saveEnvsMap(context, currentMap);
          await mongoUpsert(currentMap[envId]);
        }
      } catch (err: any) {
        appendBuildLog(buildLogPath, `[${new Date().toISOString()}] WARN: Failed to persist: ${err.message}`);
      }
    };

    const composeHostPath = join(env.workdir, env.composeFile);

    if (rebuild) {
      runBuildInBackground({ envId, workdir: env.workdir, composeHostPath, projectHostDir: env.hostPath, projectName: env.projectName, networkName: env.networkName, envVarArgs: '', timeoutSecs: 300, buildLogPath, persistFn })
        .catch((err) => {
          appendBuildLog(buildLogPath, `[${new Date().toISOString()}] FATAL: ${err.message}`);
          persistFn({ status: 'error', error: err.message, updatedAt: new Date().toISOString() }).catch(() => {});
        });
    } else {
      // Quick restart: docker compose restart
      const doRestart = async () => {
        try {
          appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Running docker compose restart`);
          const { stdout, stderr } = await runCompose(env.workdir, composeHostPath, env.projectName, 'restart', 60_000);
          appendBuildLog(buildLogPath, stdout || stderr || '(no output)');

          const hasRunning = await isAnyContainerRunning(env.projectName);
          if (hasRunning) {
            appendBuildLog(buildLogPath, `[${new Date().toISOString()}] Restart successful`);
            await persistFn({ status: 'running', updatedAt: new Date().toISOString() });
          } else {
            const errMsg = `Restart completed but no containers running. stderr: ${stderr.slice(0, 500)}`;
            appendBuildLog(buildLogPath, `[${new Date().toISOString()}] ERROR: ${errMsg}`);
            await persistFn({ status: 'error', error: errMsg, updatedAt: new Date().toISOString() });
          }
        } catch (err: any) {
          appendBuildLog(buildLogPath, `[${new Date().toISOString()}] FATAL: ${err.message}`);
          await persistFn({ status: 'error', error: err.message, updatedAt: new Date().toISOString() }).catch(() => {});
        }
      };
      doRestart().catch(() => {});
    }

    return {
      success: true,
      envId,
      status: 'building',
      rebuild,
      message: rebuild
        ? 'Environment is being rebuilt and restarted in the background.'
        : 'Environment is restarting in the background.',
      hint: `Poll with env-status envId="${envId}"`,
    };
  },
});

// ============================================================================
// TOOL: env-destroy
// ============================================================================

server.tool('env-destroy', {
  description:
    'Stop and remove a Docker environment: runs docker-compose down, removes containers, networks, and volumes. The local workspace directory (localPath) is NOT deleted. This action is irreversible.',
  parameters: {
    type: 'object',
    properties: {
      envId: { type: 'string', description: 'Environment ID to destroy' },
      removeVolumes: { type: 'boolean', description: 'Also remove named Docker volumes (default: true)', default: true },
    },
    required: ['envId'],
  },
  handler: async (args, context) => {
    const userId = context.execution.userId;
    const envId = args.envId as string;
    const removeVolumes = (args.removeVolumes as boolean) !== false;

    if (!envId) throw new Error('envId is required');

    const envsMap = await loadEnvsMap(context);
    if (!envsMap[envId]) throw new Error(`Environment ${envId} not found.`);
    const env: EnvRecord = envsMap[envId];
    assertOwnership(env, userId);

    const results: Record<string, any> = {};
    const volumeFlag = removeVolumes ? '--volumes' : '';
    const composeHostPath = join(env.workdir, env.composeFile);

    // Remove Caddy route first (best-effort)
    try {
      await removeCaddyRoute(envId);
      results.caddyRouteRemoved = true;
    } catch (err: any) {
      results.caddyRouteRemoved = false;
      results.caddyRouteError = err.message;
    }

    // docker-compose down
    const downResult = await runCompose(env.workdir, composeHostPath, env.projectName, `down --remove-orphans ${volumeFlag}`, 60_000);
    results.composeDown = { stdout: downResult.stdout.slice(0, 500), stderr: downResult.stderr.slice(0, 500) };

    // Remove isolated network
    try {
      await execAsync(`DOCKER_HOST="${DOCKER_HOST}" docker network rm "${env.networkName}" 2>/dev/null || true`, { timeout: 15_000,  });
      results.networkRemoved = true;
    } catch {
      results.networkRemoved = false;
    }

    // Remove from store (in-memory + MongoDB)
    const updatedEnvsMap = { ...envsMap };
    delete updatedEnvsMap[envId];
    await saveEnvsMap(context, updatedEnvsMap);
    await mongoDelete(envId);

    return { success: true, envId, projectName: env.projectName, ...results, message: `Environment ${envId} destroyed successfully` };
  },
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

server.tool('-health-check', {
  description: 'Internal health check. Verifies Docker socket connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    let dockerOk = false;
    let dockerVersion = '';
    let dockerError = '';

    try {
      const { stdout } = await execAsync(`DOCKER_HOST="${DOCKER_HOST}" docker version --format "{{.Server.Version}}"`, { timeout: 5_000,  });
      dockerVersion = stdout.trim();
      dockerOk = !!dockerVersion;
    } catch (err: any) {
      dockerError = err.message;
    }

    return {
      status: dockerOk ? 'ready' : 'not_ready',
      version: '1.1.0',
      checks: { docker: { ok: dockerOk, version: dockerVersion || undefined, error: dockerError || undefined } },
      dockerHost: DOCKER_HOST,
      baseDomain: BASE_DOMAIN,
      logDir: LOG_DIR,
    };
  },
});

// ============================================================================
// START
// ============================================================================

async function main() {
  // Step 1: Connect to MongoDB and rehydrate in-memory state
  await initMongo();

  if (envsCollection) {
    try {
      const docs = await envsCollection.find({}).toArray();
      if (docs.length > 0) {
        console.error(`🔄 Rehydrating ${docs.length} environment(s) from MongoDB...`);
        // We can't access context.setData here (no request context), so we prime
        // a module-level rehydration map that loadEnvsMap will merge on first call.
        for (const doc of docs) {
          const { _id, ...record } = doc as any;
          rehydratedEnvs[record.envId] = record as EnvRecord;
        }
        console.error(`✅ Rehydration complete: ${Object.keys(rehydratedEnvs).join(', ')}`);
      } else {
        console.error('ℹ️  No environments found in MongoDB to rehydrate');
      }
    } catch (err: any) {
      console.error(`⚠️  Rehydration failed: ${err.message}`);
    }
  }

  // Step 2: Start MCA server
  await server.start();
  console.error('🐳 Teros Docker Env MCA server running (v1.2.0)');
  console.error(`   DOCKER_HOST: ${DOCKER_HOST}`);
  console.error(`   BASE_DOMAIN: ${BASE_DOMAIN}`);
  console.error(`   LOG_DIR: ${LOG_DIR}`);
}

main().catch((error) => {
  console.error('Failed to start MCA:', error);
  process.exit(1);
});
