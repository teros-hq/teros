/**
 * MCA Manager — Spawn implementation sub-module
 *
 * spawnContainer(), spawnStdio(), buildExecutionConfig().
 * Depends on SpawnContext from mca-manager.spawn.ts.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import type { Readable } from 'stream';
import type { App, McpCatalogEntry } from '../types/database';
import { captureException } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import { McaHttpClient } from './mca-http-client';
import type { ManagedMca, ToolDefinition, ExecutionConfig } from './mca-manager.types';
import type { SpawnContext } from './mca-manager.spawn';
import { setupWatchdog } from './mca-manager.spawn';
import { resolveDockerNetwork } from './mca-network-policy';

// This package is ESM ("type": "module") — __dirname must be derived, same as config.ts
const __dirname = dirname(fileURLToPath(import.meta.url));

const log = createLogger('McaManager');

// Regex for environment variable interpolation: matches ${VAR} or $VAR
const ENV_VAR_PATTERN = /\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g;

/** Loopback hosts that resolve to the container itself and must be rewritten. */
const MONGO_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Rewrite loopback hosts in a Mongo URI to a container-reachable host, touching
 * ONLY the authority's host list. A global replace over the whole URI would also
 * mangle a `localhost` appearing in the credentials, the database-name path
 * segment, or a query param like `authSource` — corrupting auth or splitting the
 * MCA onto a different database. Handles multi-host (replica set) authorities;
 * anything that doesn't parse as `mongodb[+srv]://` is returned unchanged.
 *
 * Each comma-separated host entry is matched WHOLE (host + optional :port, IPv6
 * brackets kept intact) and rewritten only on an EXACT loopback match — so a
 * legit hostname that merely contains "localhost" (e.g. `localhost.corp.net`) is
 * left alone, and the IPv6 loopback `[::1]` — which the old substring replace
 * missed entirely, leaving containers pointed at their own loopback — is covered.
 */
function rewriteMongoUriHost(uri: string, host: string): string {
  return uri.replace(
    /^(mongodb(?:\+srv)?:\/\/)(?:([^@/]*)@)?([^/?]+)/,
    (_m, scheme: string, creds: string | undefined, hosts: string) => {
      const rewritten = hosts
        .split(',')
        .map((entry) => {
          // Split host from optional :port, keeping an IPv6 [..] literal intact.
          const parts = entry.match(/^(\[[^\]]+\]|[^:]+)(:\d+)?$/);
          if (!parts) return entry;
          const [, hostPart, port = ''] = parts;
          return MONGO_LOOPBACK_HOSTS.has(hostPart) ? `${host}${port}` : entry;
        })
        .join(',');
      return `${scheme}${creds !== undefined ? `${creds}@` : ''}${rewritten}`;
    },
  );
}

/**
 * Resolves the host-side path of the workspace volume for the app owner.
 * Used by MCAs that need to translate /workspace paths for Docker bind mounts
 * (e.g. mca.teros.docker-env) or to provision persistent app-data directories.
 *
 * Returns undefined if the volume cannot be resolved (logs a warning).
 */
async function resolveWorkspaceHostPath(
  ctx: SpawnContext,
  app: App,
): Promise<string | undefined> {
  if (!ctx.config.volumeService) return undefined;

  if (app.ownerId.startsWith('work_') || app.ownerId.startsWith('ws_')) {
    const db = (ctx.config.volumeService as any).db as import('mongodb').Db;
    const workspace = await db
      .collection('workspaces')
      .findOne({ workspaceId: app.ownerId });
    if (workspace?.volumeId) {
      const vol = await ctx.config.volumeService.getVolume(workspace.volumeId);
      return vol?.hostPath;
    }
    log.warn({ appId: app.appId, ownerId: app.ownerId }, 'resolveWorkspaceHostPath: workspace has no volumeId');
    return undefined;
  }

  // Non-workspace owner — should not happen in the unified model
  log.warn({ appId: app.appId, ownerId: app.ownerId }, 'resolveWorkspaceHostPath: ownerId has no recognized workspace prefix (expected work_ or ws_)');
  return undefined;
}

export async function spawnContainer(
  ctx: SpawnContext,
  appId: string,
  app: App,
  mca: McpCatalogEntry,
  restartCount: number,
): Promise<ManagedMca> {
  const containerMode = mca.runtime?.containerMode || 'shared';
  log.info({ appId, containerMode }, 'Spawning container for MCA');

  // Create placeholder entry
  const managed: ManagedMca = {
    appId,
    mcaId: app.mcaId,
    appName: app.name,
    client: null,
    transport: null,
    tools: [],
    toolNameMapping: new Map(),
    status: 'starting',
    lastUsed: new Date(),
    restartCount,
  };
  ctx.mcas.set(appId, managed);

  try {
    // Resolve volume mounts from app configuration
    const volumes: Array<{ hostPath: string; containerPath: string; readOnly: boolean }> = [];

    if (app.volumes?.length && ctx.config.volumeService) {
      const resolvedMounts = await ctx.config.volumeService.resolveVolumeMounts(
        app.volumes,
        app.ownerId,
      );
      volumes.push(...resolvedMounts);
      log.debug({ appId, volumeCount: volumes.length }, 'Resolved volume mounts');
    }

    // Build environment variables for the container
    const environment: Record<string, string> = {
      MCA_APP_ID: appId,
      MCA_APP_NAME: app.name,
      MCA_MCP_ID: app.mcaId,
      MCA_OWNER_ID: app.ownerId,
      MCA_OWNER_TYPE: app.ownerType || 'workspace',
    };

    // Add MongoDB connection info (for MCAs that need direct DB access).
    // The URI must be reachable from INSIDE the spawned container. A `localhost`
    // in the backend's URI is the backend host's loopback — inside the container it
    // resolves to the container itself (→ ECONNREFUSED ::1/127.0.0.1:27017). Rewrite
    // localhost/127.0.0.1 to the container-reachable MONGO host.
    //
    // This host is NOT the backend host. Mongo is published on the host loopback
    // (docker-compose.yml: 127.0.0.1:27017), so `host.docker.internal` (the bridge
    // gateway used for the WS callback) is refused by that loopback-only socket.
    // Internal MCAs (scheduler, memory, …) that hold direct Mongo access join
    // `teros_teros-network`, where Mongo resolves as the compose service DNS
    // `mongodb` — the correct default (ctx.containerMongoHost). In a real compose/k8s
    // deploy the backend URI already targets a service name (no localhost) so the
    // rewrite is a no-op. We always inject — even when the backend has no MONGODB_URI
    // set — so containerized MCAs never silently fall back to their own localhost.
    //
    // MCA_MONGODB_URI is an explicit override for remote-execution machines whose
    // containers reach Mongo over a private network the backend's own URI can't
    // describe (documented in .env.example / TWO-HOST-SEPARATION-PLAN). It is used
    // VERBATIM — no loopback rewrite — since it already targets the reachable host.
    if (process.env.MCA_MONGODB_URI) {
      environment.MONGODB_URI = process.env.MCA_MONGODB_URI;
    } else {
      const backendMongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
      environment.MONGODB_URI = rewriteMongoUriHost(backendMongoUri, ctx.containerMongoHost);
    }
    // Inject the DB name under both env names MCAs read in the wild (MONGODB_DATABASE
    // and the legacy MONGODB_DB_NAME) so the injected value is honored regardless of
    // which name a given MCA expects — no per-MCA change required. Resolution mirrors
    // the backend's own connection (index.ts): env var > `database` system secret >
    // 'teros', so a secrets-only deploy (env unset) injects the SAME db the backend uses
    // instead of silently forcing MCAs onto 'teros'.
    const mongoDbName =
      process.env.MONGODB_DATABASE ||
      process.env.MONGODB_DB_NAME ||
      ctx.config.secretsManager?.system?.('database')?.database ||
      'teros';
    environment.MONGODB_DATABASE = mongoDbName;
    environment.MONGODB_DB_NAME = mongoDbName;

    // Add WebSocket connection info if connection manager is available
    if (ctx.connectionManager) {
      const wsToken = ctx.connectionManager.registerPendingConnection(
        app.appId,
        app.mcaId,
        app.ownerId,
      );
      environment.MCA_WS_URL = `ws://${ctx.containerBackendHost}:${ctx.config.serverPort}/mca?appId=${app.appId}&token=${wsToken}`;
      environment.MCA_WS_TOKEN = wsToken;
      log.debug({ appId }, 'McaManager operation');
    }

    // Add backend URL for OAuth redirects
    const staticBaseUrl =
      process.env.STATIC_BASE_URL || `http://localhost:${ctx.config.serverPort}/static`;
    const backendUrl = staticBaseUrl.replace('/static', '');
    environment.MCA_BACKEND_URL = backendUrl;

    // Inject MCA secrets as SECRET_MCA_* env vars so HTTP containerized MCAs can read them.
    // This mirrors what buildExecutionConfig() does for stdio MCAs.
    const mcaSecrets = ctx.config.secretsManager?.mca(app.mcaId);
    const mcaSecretEnv: Record<string, string> = {};
    if (mcaSecrets) {
      for (const [k, v] of Object.entries(mcaSecrets)) {
        if (v !== undefined && v !== null) {
          const envKey = ctx.toEnvKey('SECRET_MCA', k);
          mcaSecretEnv[envKey] = String(v);
          environment[envKey] = String(v);
        }
      }
    }

    // Inject system-level environment variables from manifest (e.g. DOCKER_HOST, DOCKER_ENV_DOMAIN)
    // These are merged before per-MCA overrides so the latter can take precedence.
    // Values support $VAR or ${VAR} interpolation against the backend process environment
    // and the container environment built so far (e.g. ${MCA_APP_ID} for per-container proxy routing).
    if (mca.runtime?.systemEnvironment) {
      for (const [key, value] of Object.entries(mca.runtime.systemEnvironment)) {
        const resolved = value.replace(new RegExp(ENV_VAR_PATTERN.source, 'g'), (_, braced, bare) => {
          const envKey = braced ?? bare;
          return environment[envKey] ?? mcaSecretEnv[envKey] ?? process.env[envKey] ?? '';
        });
        environment[key] = resolved;
      }
      log.debug({ appId }, 'McaManager operation');
    }

    // Inject WORKSPACE_HOST_PATH for MCAs that need to translate /workspace paths for Docker.
    // The value is the real host-side path of the owner's volume so that Docker
    // bind mounts work correctly (the Docker daemon runs on the host, not in the container).
    if (app.mcaId === 'mca.teros.docker-env') {
      if (!ctx.config.volumeService) {
        throw new Error(
          'Cannot start mca.teros.docker-env: VolumeService is not available. WORKSPACE_HOST_PATH cannot be resolved.',
        );
      }
      const workspaceHostPath = await resolveWorkspaceHostPath(ctx, app);
      if (!workspaceHostPath) {
        throw new Error(
          `Cannot start mca.teros.docker-env: failed to resolve workspace host path for owner ${app.ownerId}`,
        );
      }
      environment.WORKSPACE_HOST_PATH = workspaceHostPath;
      log.debug({ appId }, 'McaManager operation');
    }

    // Mount a persistent app-data directory into /app-data if the MCA requests it.
    // The directory lives at {workspaceHostPath}/.apps/{app.name}/ on the host.
    // This allows MCAs like WhatsApp (WAHA) to persist session state across container restarts.
    if (mca.runtime?.appDataMount === true) {
      if (!ctx.config.volumeService) {
        throw new Error(
          `Cannot mount app-data for ${app.mcaId}: VolumeService is not available.`,
        );
      }
      const workspaceHostPath = await resolveWorkspaceHostPath(ctx, app);
      if (!workspaceHostPath) {
        throw new Error(
          `Cannot mount app-data for ${app.mcaId}: failed to resolve workspace host path for owner ${app.ownerId}`,
        );
      }
      const appDataHostPath = `${workspaceHostPath}/.apps/${app.name}`;
      mkdirSync(appDataHostPath, { recursive: true });
      volumes.push({
        hostPath: appDataHostPath,
        containerPath: '/app-data',
        readOnly: false,
      });
      log.info({ appId, appDataHostPath }, 'Mounted persistent app-data directory');
    }

    // Mount the owner's workspace volume at /workspace when the MCA requests it
    // (e.g. mca.teros.bash). Gives the container direct read-write access to the
    // user's workspace files — which, unlike the container FS, persist. Paired
    // with appDataMount, whose .apps/{name} dir also lives under this volume.
    if (mca.runtime?.workspaceMount === true) {
      if (!ctx.config.volumeService) {
        throw new Error(
          `Cannot mount workspace for ${app.mcaId}: VolumeService is not available.`,
        );
      }
      const workspaceHostPath = await resolveWorkspaceHostPath(ctx, app);
      if (!workspaceHostPath) {
        throw new Error(
          `Cannot mount workspace for ${app.mcaId}: failed to resolve workspace host path for owner ${app.ownerId}`,
        );
      }
      volumes.push({
        hostPath: workspaceHostPath,
        containerPath: '/workspace',
        readOnly: false,
      });
      environment.MCA_WORKSPACE_PATH = '/workspace';
      log.info({ appId, workspaceHostPath }, 'Mounted workspace at /workspace');
    }

    // @todo alice - 2026.04.25 : remove this comment once .sessions/ dir is cleaned up from host
    // WAHA sessions are now persisted via appDataMount (workspaceHostPath/.apps/{app.name})
    // mounted at /app-data, with WAHA_SESSIONS_FOLDER=/app-data set in the manifest.

    // Add system-level volume mounts from manifest (e.g. Docker socket for docker-env)
    if (mca.runtime?.systemVolumes?.length) {
      for (const sv of mca.runtime.systemVolumes) {
        volumes.push({
          hostPath: sv.hostPath,
          containerPath: sv.containerPath,
          readOnly: sv.readOnly ?? false,
        });
      }
      log.debug({ appId }, 'McaManager operation');
    }

    // Pick the container's Docker network. Internal-access MCAs join the network
    // with Mongo/Qdrant; egress MCAs (mca.teros.http / mca.netlify / mca.make) join
    // the DEDICATED, internal-service-free `teros_egress` network (so a compromised
    // egress MCA can't reach Mongo/Qdrant at the network layer — defence beyond the
    // app SSRF guard). Everything else gets no network (default-deny). In prod,
    // host iptables on the egress subnet also drop metadata + RFC1918. See
    // mca-network-policy.ts + scripts/setup-egress-firewall.sh.
    const dockerNetwork = resolveDockerNetwork(app.mcaId);

    // Start container with resolved volumes, container mode, custom image, and environment
    const containerInfo = await ctx.containerManager.getOrStart(app.mcaId, {
      volumes: volumes.map((v) => ({
        hostPath: v.hostPath,
        containerPath: v.containerPath,
        readOnly: v.readOnly,
      })),
      appId,
      containerMode,
      image: mca.runtime?.dockerImage,
      environment,
      dockerNetwork,
      // Per-MCA runtime resource caps from the manifest. Without these, the
      // container backend falls back to fleet-wide defaults (or unlimited), so a
      // memory-hungry/runaway MCA can exhaust host resources. Honored by the
      // docker backend via `options.cpus ?? defaultCpus` / `memoryMb ?? default`.
      cpus: mca.runtime?.resources?.cpus,
      memoryMb: mca.runtime?.resources?.memoryMb,
    });
    log.debug({ appId }, 'McaManager operation');

    // Store container key for later use (touch, etc.)
    // For shared mode: mcpId, for per-app mode: appId
    managed.containerKey = containerMode === 'per-app' ? appId : app.mcaId;

    // Create HTTP client
    const httpClient = new McaHttpClient({ baseUrl: containerInfo.baseUrl });
    ctx.httpClients.set(appId, httpClient);

    // Discover tools via HTTP
    const toolsResponse = await httpClient.listTools();
    const toolNameMapping = new Map<string, string>();
    const tools: ToolDefinition[] = [];

    for (const tool of toolsResponse.tools) {
      const originalName = tool.name;
      const kebabToolName = originalName.replace(/_/g, '-');
      const sanitizedName = `${managed.appName}_${kebabToolName}`;

      toolNameMapping.set(sanitizedName, originalName);

      if (originalName.startsWith('_')) {
        log.trace({ originalName }, 'Skipping internal tool');
        continue;
      }

      tools.push({
        name: sanitizedName,
        description: tool.description || '',
        input_schema: {
          type: 'object' as const,
          properties: tool.parameters?.properties || {},
          required: tool.parameters?.required,
        },
      });
    }

    log.info({ appId, toolCount: tools.length }, 'Discovered tools from container');
    tools.forEach((tool) => log.debug({ toolName: tool.name }, 'Discovered tool'));

    // Update managed entry
    managed.tools = tools;
    managed.toolNameMapping = toolNameMapping;
    managed.status = 'ready';
    managed.restartCount = 0; // started OK — clear the retry counter (TER-559)

    return managed;
  } catch (error: any) {
    log.error({ err: error, appId }, 'Failed to spawn container');
    captureException(error, { context: 'spawnContainer', appId, mcaId: app.mcaId });
    managed.status = 'error';
    managed.lastError = error.message;
    throw error;
  }
}

export async function spawnStdio(
  ctx: SpawnContext,
  appId: string,
  app: App,
  mca: McpCatalogEntry,
  restartCount: number,
): Promise<ManagedMca> {
  log.info({ appId }, 'Spawning stdio process for MCA');

  // Create placeholder entry
  const managed: ManagedMca = {
    appId,
    mcaId: app.mcaId,
    appName: app.name,
    client: null as any, // Will be set below
    transport: null as any, // Will be set below
    tools: [],
    toolNameMapping: new Map(),
    status: 'starting',
    lastUsed: new Date(),
    restartCount,
  };
  ctx.mcas.set(appId, managed);

  try {
    // Build execution config
    const { command, args, cwd, environment } = await buildExecutionConfig(ctx, app, mca);

    log.debug({ command, args }, 'Spawn command');
    log.debug({ cwd }, 'Spawn CWD');

    // Log which secret env vars are set for debugging — never their values.
    // Everything under the SECRET_MCA_*/SECRET_USER_* prefixes is a secret by
    // construction, so mask all values (a keyword allowlist like KEY/TOKEN/
    // PASSWORD leaks *_SECRET, *_CREDENTIAL, *_AUTH, webhook URLs, etc.).
    const secretEnvVars = Object.entries(environment)
      .filter(([k]) => k.startsWith('SECRET_MCA_') || k.startsWith('SECRET_USER_'))
      .map(([k]) => `${k}=***`);
    log.debug({ secretEnvVars }, 'Secret env vars');

    // Verify CWD exists
    const { existsSync } = await import('fs');
    if (!existsSync(cwd)) {
      throw new Error(`CWD does not exist: ${cwd}`);
    }
    log.debug({ cwd }, 'CWD exists');

    // Create stdio transport with stderr piped for logging
    const transport = new StdioClientTransport({
      command,
      args,
      env: environment,
      cwd,
      stderr: 'pipe', // Capture stderr for per-MCA logging
    });

    // Create MCP client
    const client = new Client(
      {
        name: `teros-mca-${appId}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      },
    );

    // Connect
    log.debug({ appId }, 'Connecting to MCA process');
    await client.connect(transport);
    log.info({ appId }, 'Connected to MCA');

    // Setup stderr logging after connection
    ctx.setupStderrLogging(appId, managed.appName, managed.mcaId, transport);

    // Discover tools
    const toolsResponse = await client.listTools();
    const toolNameMapping = new Map<string, string>();

    // Prefix tool names with app name (user-defined, unique per user)
    // Format: <app-name>_<tool-kebab> e.g., bash_bash, gmail-work_read-email
    // Tool names use kebab-case (underscores converted to hyphens)
    // Internal tools (starting with _) are kept in mapping but not exposed to LLM
    const tools: ToolDefinition[] = [];

    for (const tool of toolsResponse.tools) {
      const originalName = tool.name;
      // Convert tool name to kebab-case: read_email -> read-email
      const kebabToolName = originalName.replace(/_/g, '-');
      const sanitizedName = `${managed.appName}_${kebabToolName}`;

      // Always add to mapping (needed for health check and internal tools)
      toolNameMapping.set(sanitizedName, originalName);

      // Skip internal tools (starting with _) from public tool list
      if (originalName.startsWith('_')) {
        log.trace({ originalName }, 'Skipping internal tool');
        continue;
      }

      // MCP tools return JSON Schema which should have type: 'object'
      const inputSchema = tool.inputSchema as {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
      };

      tools.push({
        name: sanitizedName,
        description: tool.description || '',
        input_schema: {
          type: 'object' as const,
          properties: inputSchema.properties || {},
          required: inputSchema.required,
        },
      });
    }

    log.info({ appId, toolCount: tools.length }, 'Discovered public tools from MCA');
    tools.forEach((tool) => log.debug({ toolName: tool.name }, 'Discovered tool'));

    // Update managed entry
    managed.client = client;
    managed.transport = transport;
    managed.tools = tools;
    managed.toolNameMapping = toolNameMapping;
    managed.status = 'ready';

    // Setup watchdog for this process
    setupWatchdog(ctx, appId, transport);

    // Perform initial health check (async, don't block spawn)
    ctx.performInitialHealthCheck(appId).catch((err) => {
      log.warn({ err, appId }, 'Initial health check failed');
    });

    return managed;
  } catch (error: any) {
    log.error({ err: error, appId }, 'Failed to spawn MCA');
    log.error({ err: error }, 'Full spawn error');
    captureException(error, { context: 'spawnStdio', appId, mcaId: app.mcaId });
    managed.status = 'error';
    managed.lastError = error.message;
    throw error;
  }
}

export async function buildExecutionConfig(
  ctx: SpawnContext,
  app: App,
  mca: McpCatalogEntry,
): Promise<ExecutionConfig> {
  const execution = mca.execution;

  // Build CWD (MCA's configured working directory)
  const cwd = execution.cwd
    ? `${ctx.config.mcaBasePath}/${execution.cwd}`
    : ctx.config.mcaBasePath;

  // Build environment variables
  const environment: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCA_APP_ID: app.appId,
    MCA_APP_NAME: app.name,
    MCA_MCP_ID: app.mcaId,
    MCA_CWD: cwd,
    MCA_OWNER_ID: app.ownerId,
    MCA_OWNER_TYPE: app.ownerType || 'workspace',
  };

  // Catalog commands are bare names (`tsx`) resolved via PATH. Runners like
  // `bun run`/`yarn` prepend node_modules/.bin automatically, but a directly
  // launched backend (pm2 → tsx) does not — prepend the backend and repo-root
  // .bin dirs so stdio MCAs spawn regardless of how the backend was started.
  const binDirs = [
    join(__dirname, '..', '..', 'node_modules', '.bin'),
    join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin'),
  ];
  environment.PATH = [...binDirs, environment.PATH].filter(Boolean).join(delimiter);

  // Resolve and pass the workspace/user volume path as MCA_WORKSPACE_PATH
  // This allows stdio MCAs to access the correct filesystem for both user and workspace apps
  if (ctx.config.volumeService) {
    try {
      let volumePath: string | undefined;

      if (app.ownerType === 'workspace') {
        // Workspace app: get workspace's volume
        const workspaceService = ctx.mcaService['workspaceService'];
        if (workspaceService) {
          const workspace = await workspaceService.getWorkspace(app.ownerId);
          if (workspace?.volumeId) {
            const volume = await ctx.config.volumeService.getVolume(workspace.volumeId);
            volumePath = volume?.hostPath;
          }
        }
      } else {
        // Fallback for legacy/unknown ownerType — should not happen in unified model
        log.warn({ appId: app.appId, ownerType: (app as any).ownerType }, "MCA_WORKSPACE_PATH: ownerType is not 'workspace', skipping volume resolution");
      }

      if (volumePath) {
        environment.MCA_WORKSPACE_PATH = volumePath;
        log.debug({ appId: app.appId }, 'Volume mount resolved');
      }
    } catch (error) {
      log.warn({ err: error, appId: app.appId }, 'Failed to resolve workspace path');
    }
  }

  // Add WebSocket connection info if connection manager is available
  if (ctx.connectionManager) {
    const wsToken = ctx.connectionManager.registerPendingConnection(
      app.appId,
      app.mcaId,
      app.ownerId,
    );
    environment.MCA_WS_URL = `ws://localhost:${ctx.config.serverPort}/mca?appId=${app.appId}&token=${wsToken}`;
    environment.MCA_WS_TOKEN = wsToken;
  }

  // Add backend URL for OAuth redirects (MCAs use this to build auth URLs)
  // Derive from STATIC_BASE_URL or use localhost as fallback
  const staticBaseUrl =
    process.env.STATIC_BASE_URL || `http://localhost:${ctx.config.serverPort}/static`;
  const backendUrl = staticBaseUrl.replace('/static', '');
  environment.MCA_BACKEND_URL = backendUrl;

  // Add callback URL for stdio MCAs to access secrets via HTTP
  environment.MCA_CALLBACK_URL = `http://localhost:${ctx.config.serverPort}/mca/callback/${app.appId}`;

  // Add secrets as SECRET_MCA_* (loaded from filesystem via SecretsManager)
  const secrets = ctx.config.secretsManager?.mca(app.mcaId);
  if (secrets) {
    for (const [key, value] of Object.entries(secrets)) {
      if (value !== undefined && value !== null) {
        environment[ctx.toEnvKey('SECRET_MCA', key)] = String(value);
      }
    }
  }

  // Add user auth as SECRET_USER_* (loaded from AuthManager or fallback to app.auth)
  let userAuth = app.auth; // Fallback to legacy app.auth

  // Try to load from AuthManager if available
  const authManager = ctx.mcaService['authManager'];
  log.debug({ appId: app.appId }, 'Loading credentials');

  if (authManager && app.ownerId) {
    try {
      const credentials = await authManager.get(app.ownerId, app.appId);
      log.debug({ appId: app.appId, ownerId: app.ownerId, keys: credentials ? Object.keys(credentials) : null }, 'Loaded credentials');
      if (credentials) {
        userAuth = credentials; // Override with decrypted user credentials
      }
    } catch (error) {
      log.warn({ err: error, appId: app.appId, ownerId: app.ownerId }, 'Failed to load user credentials');
    }
  }

  if (userAuth) {
    for (const [key, value] of Object.entries(userAuth)) {
      if (value !== undefined && value !== null) {
        environment[ctx.toEnvKey('SECRET_USER', key)] = String(value);
      }
    }
  }

  return {
    command: execution.command,
    args: execution.args,
    cwd,
    environment,
  };
}
