/**
 * deploy-site — deploy a static site from the workspace to Netlify.
 *
 * Flow (Netlify file-digest deploy API):
 *   1. Walk the caller-supplied dir under the jail, SHA1 every file → digest.
 *   2. Resolve the target site (by id, by name, or create a fresh one).
 *   3. POST the digest → deploy id + `required` (SHA1s Netlify still needs).
 *   4. PUT the raw bytes of each required file.
 *   5. Poll the deploy until `ready` → return the public URL.
 *
 * SECURITY: the deployed bytes become PUBLICLY readable on the internet. The dir
 * is chosen by the calling agent (prompt-injection surface), so this tool gates
 * on permission (`destructiveHint`) and refuses to publish the whole workspace
 * root unless the caller explicitly confirms with `allowWorkspaceRoot: true`.
 *
 * Returns DATA (url, ids, state, counts) — the renderer composes the sentence.
 */

import type { ToolConfig } from '@teros/mca-sdk';
import { buildDigest, type Digest, readFileNoFollow } from '../lib/digest';
import { NetlifyClient, type NetlifyDeploy, type NetlifySite } from '../lib/netlify-client';
import { PathJail } from '../lib/path-jail';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SUCCESS_STATE = 'ready';
const FAILURE_STATES = new Set(['error', 'rejected']);

/**
 * The subset of `NetlifyClient` the deploy flow drives. Declaring it as an
 * interface lets `executeDeploy` be exercised with a faithful in-memory fake —
 * no network, no module mocking — while `NetlifyClient` satisfies it structurally.
 */
export interface DeployClient {
  listSites(): Promise<NetlifySite[]>;
  createSite(name?: string): Promise<NetlifySite>;
  createDeploy(siteId: string, files: Record<string, string>, draft: boolean): Promise<NetlifyDeploy>;
  uploadFile(deployId: string, deployPath: string, bytes: Uint8Array): Promise<NetlifyDeploy>;
  getDeploy(deployId: string): Promise<NetlifyDeploy>;
}

export interface DeployFlowOptions {
  siteId?: string;
  siteName?: string;
  draft: boolean;
  /** Poll interval override (tests use a tiny value). Defaults to 2.5s. */
  pollIntervalMs?: number;
  /** Poll timeout override (tests use a tiny value). Defaults to 5min. */
  pollTimeoutMs?: number;
}

export interface DeployResult {
  url: string | null;
  deployId: string;
  state: string;
  siteId: string;
  siteName: string | null;
  draft: boolean;
  fileCount: number;
  uploadedCount: number;
}

/** Sleep that rejects with `[CANCELLED]` if the caller aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('[CANCELLED] deploy aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('[CANCELLED] deploy aborted'));
      },
      { once: true },
    );
  });
}

/** Poll GET /deploys/{id} until ready; throw on failure / timeout. */
async function pollUntilReady(
  client: DeployClient,
  deployId: string,
  signal?: AbortSignal,
  intervalMs: number = POLL_INTERVAL_MS,
  timeoutMs: number = POLL_TIMEOUT_MS,
): Promise<NetlifyDeploy> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const deploy = await client.getDeploy(deployId);
    if (deploy.state === SUCCESS_STATE) return deploy;
    if (FAILURE_STATES.has(deploy.state)) {
      throw new Error(
        `[DEPLOY_FAILED] Netlify deploy ${deployId} ${deploy.state}: ${deploy.error_message ?? 'no detail provided'}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[DEPLOY_TIMEOUT] deploy ${deployId} still '${deploy.state}' after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    await sleep(intervalMs, signal);
  }
}

/** Upload each required file (content-addressed by SHA1); return the count. */
async function uploadRequired(
  client: DeployClient,
  deployId: string,
  required: string[],
  digest: Digest,
): Promise<number> {
  let uploaded = 0;
  for (const sha1 of required) {
    const file = digest.bySha1.get(sha1);
    if (!file) continue; // SHA1 we don't have locally (e.g. functions) — skip.
    // Re-read symlink-safe (O_NOFOLLOW): the bytes were hashed during the walk
    // but not retained (memory bound); guard the re-read against a TOCTOU swap.
    const bytes = await readFileNoFollow(file.absPath);
    await client.uploadFile(deployId, file.deployPath, bytes);
    uploaded += 1;
  }
  return uploaded;
}

/** Resolve the target site id: explicit id > existing-by-name > create. */
async function resolveSite(
  client: DeployClient,
  opts: { siteId?: string; siteName?: string },
): Promise<{ id: string; name?: string }> {
  if (opts.siteId) return { id: opts.siteId };
  if (opts.siteName) {
    // listSites() is fully paginated, so an existing site on page 2+ is found
    // here instead of being mistaken for "missing" and duplicated by createSite.
    const sites = await client.listSites();
    const existing = sites.find((s) => s.name === opts.siteName);
    if (existing) return { id: existing.id, name: existing.name };
    const created = await client.createSite(opts.siteName);
    return { id: created.id, name: created.name };
  }
  const created = await client.createSite();
  return { id: created.id, name: created.name };
}

/**
 * Core deploy flow against an injected client + prepared digest. Exported so the
 * full happy/error/timeout/draft matrix is testable with a fake client.
 */
export async function executeDeploy(
  client: DeployClient,
  digest: Digest,
  opts: DeployFlowOptions,
  signal?: AbortSignal,
): Promise<DeployResult> {
  const site = await resolveSite(client, { siteId: opts.siteId, siteName: opts.siteName });
  const deploy = await client.createDeploy(site.id, digest.files, opts.draft);
  const uploaded = await uploadRequired(client, deploy.id, deploy.required ?? [], digest);
  const finalDeploy = await pollUntilReady(
    client,
    deploy.id,
    signal,
    opts.pollIntervalMs,
    opts.pollTimeoutMs,
  );

  // Draft deploys live at the per-deploy permalink; production deploys at the
  // site's primary URL. Prefer the mode-appropriate URL, fall back to the other.
  const url = opts.draft
    ? (finalDeploy.deploy_ssl_url ?? finalDeploy.ssl_url ?? null)
    : (finalDeploy.ssl_url ?? finalDeploy.deploy_ssl_url ?? null);

  return {
    url,
    deployId: finalDeploy.id,
    state: finalDeploy.state,
    siteId: site.id,
    siteName: site.name ?? null,
    draft: opts.draft,
    fileCount: digest.list.length,
    uploadedCount: uploaded,
  };
}

export const deploySite: ToolConfig = {
  description:
    'Deploy a static site (HTML/CSS/JS) from a workspace directory to Netlify and return the public URL. ' +
    'WARNING: every file under `dir` becomes PUBLICLY readable on the internet — never deploy a directory that ' +
    'contains secrets (.env), credentials, or private data. ' +
    'Pass siteId or siteName to deploy to an existing site; omit both to create a new site. ' +
    'Deploying the whole workspace root is refused unless allowWorkspaceRoot is true. ' +
    'Returns { url, deployId, state, siteId }.',
  parameters: {
    type: 'object',
    properties: {
      dir: {
        type: 'string',
        description:
          'Directory to deploy, relative to /workspace (e.g. "site" or "build"). Must contain an index.html. ' +
          'Its entire contents become PUBLIC — point it at a build output dir, not the workspace root.',
      },
      siteId: {
        type: 'string',
        description: 'Existing Netlify site id to deploy to. Takes precedence over siteName.',
      },
      siteName: {
        type: 'string',
        description: 'Netlify site name. Deploys to the matching site if it exists, otherwise creates it.',
      },
      draft: {
        type: 'boolean',
        description: 'If true, create a draft deploy (preview URL) instead of publishing to production. Default false.',
        default: false,
      },
      allowWorkspaceRoot: {
        type: 'boolean',
        description:
          'Safety confirmation. Deploying `dir: "."` (the whole workspace root) is refused by default because the ' +
          'root usually holds private files. Set true only when the user explicitly wants the entire workspace public. ' +
          'Default false.',
        default: false,
      },
    },
    required: ['dir'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const dir = args.dir as string;
    const siteId = args.siteId as string | undefined;
    const siteName = args.siteName as string | undefined;
    const draft = (args.draft as boolean) ?? false;
    const allowWorkspaceRoot = (args.allowWorkspaceRoot as boolean) ?? false;

    const secrets = await context.getUserSecrets();
    const token = secrets.NETLIFY_TOKEN;
    if (!token) {
      throw new Error(
        '[AUTH_REQUIRED] No Netlify Personal Access Token configured. Add NETLIFY_TOKEN in the app settings.',
      );
    }

    // 1. Resolve + digest the directory (jail-checked).
    const jail = new PathJail();
    const rootDir = jail.resolveDir(dir);

    // Refuse to publish the entire workspace root unless explicitly confirmed —
    // it almost always contains private files (.env, credentials, source) that
    // must not leak to a public URL. Structural guard, not just "ask" friction.
    if (rootDir === jail.root && !allowWorkspaceRoot) {
      throw new Error(
        '[ROOT_DEPLOY_BLOCKED] Refusing to deploy the entire workspace root to a public URL. ' +
          'Point `dir` at a build output subdirectory, or pass allowWorkspaceRoot:true to confirm you really ' +
          'want every workspace file public.',
      );
    }

    const digest = await buildDigest(rootDir, jail);
    if (digest.list.length === 0) {
      throw new Error(`[EMPTY_DIR] no deployable files found in ${dir}`);
    }

    // 2-5. Resolve the target site, create the deploy, upload, poll to ready.
    const client = new NetlifyClient(token, context.signal);
    return executeDeploy(client, digest, { siteId, siteName, draft }, context.signal);
  },
};
