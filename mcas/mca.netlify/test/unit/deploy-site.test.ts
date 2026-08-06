/**
 * deploy-site flow tests.
 *
 * The pure helpers (sha1, digest, path-jail) are covered elsewhere; this file
 * exercises the ORCHESTRATION that actually ships bytes to a public URL:
 *   - `executeDeploy` against a faithful in-memory `DeployClient` fake (no
 *     network, no module mocking): site resolution (incl. the page-2 duplicate
 *     bug), the digest→create→upload→poll sequence, draft vs prod URL choice,
 *     and the poll failure/timeout branches.
 *   - the `deploy-site` handler's pre-flight guards that throw BEFORE any
 *     network call: AUTH_REQUIRED, EMPTY_DIR, and the ROOT_DEPLOY_BLOCKED
 *     guard (+ its explicit-confirmation bypass).
 *
 * Each assert pins the exact payload that crosses the client boundary (the
 * digest `files`, the `draft` flag, the uploaded deployPath + bytes) so a
 * regression that silently changes what gets deployed turns red.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDigest, type Digest } from '../../src/lib/digest';
import type { NetlifyDeploy, NetlifySite } from '../../src/lib/netlify-client';
import { PathJail } from '../../src/lib/path-jail';
import { type DeployClient, deploySite, executeDeploy } from '../../src/tools/deploy-site';

const FAILURE_STATES = new Set(['error', 'rejected']);

interface FakeConfig {
  sites?: NetlifySite[];
  created?: NetlifySite;
  deploy: NetlifyDeploy; // result of createDeploy (carries `required` + id)
  states: string[]; // getDeploy state sequence; the last entry repeats
  ready?: Partial<NetlifyDeploy>; // fields merged once state === 'ready'
  errorMessage?: string; // error_message merged on a failure state
}

/** Faithful in-memory DeployClient: records every call + payload. */
class FakeClient implements DeployClient {
  listSitesCalls = 0;
  createSiteCalls: Array<string | undefined> = [];
  createDeployCalls: Array<{ siteId: string; files: Record<string, string>; draft: boolean }> = [];
  uploadCalls: Array<{ deployId: string; deployPath: string; bytes: Uint8Array }> = [];
  getDeployCalls = 0;
  private stateIdx = 0;

  constructor(private readonly cfg: FakeConfig) {}

  async listSites(): Promise<NetlifySite[]> {
    this.listSitesCalls += 1;
    return this.cfg.sites ?? [];
  }

  async createSite(name?: string): Promise<NetlifySite> {
    this.createSiteCalls.push(name);
    return this.cfg.created ?? { id: 'site_new', name: name ?? 'site_new' };
  }

  async createDeploy(
    siteId: string,
    files: Record<string, string>,
    draft: boolean,
  ): Promise<NetlifyDeploy> {
    this.createDeployCalls.push({ siteId, files, draft });
    return { ...this.cfg.deploy };
  }

  async uploadFile(deployId: string, deployPath: string, bytes: Uint8Array): Promise<NetlifyDeploy> {
    this.uploadCalls.push({ deployId, deployPath, bytes });
    return { id: deployId, state: 'uploading' };
  }

  async getDeploy(deployId: string): Promise<NetlifyDeploy> {
    this.getDeployCalls += 1;
    const idx = Math.min(this.stateIdx, this.cfg.states.length - 1);
    const state = this.cfg.states[idx];
    this.stateIdx += 1;
    const base: NetlifyDeploy = { id: deployId, state };
    if (state === 'ready') return { ...base, ...this.cfg.ready };
    if (FAILURE_STATES.has(state)) return { ...base, error_message: this.cfg.errorMessage ?? null };
    return base;
  }
}

const BASE = join(tmpdir(), `netlify-deploy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const FAST_POLL = { pollIntervalMs: 1, pollTimeoutMs: 50 };

function makeSiteDigest(): Promise<Digest> {
  // A small real site so uploadRequired can re-read the bytes from disk.
  mkdirSync(join(BASE, 'site', 'css'), { recursive: true });
  writeFileSync(join(BASE, 'site', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(BASE, 'site', 'css', 'app.css'), 'body{}');
  const jail = new PathJail(BASE);
  return buildDigest(join(BASE, 'site'), jail);
}

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('executeDeploy — site resolution', () => {
  it('uses the explicit siteId without listing or creating sites', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_1', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 'site_abc', draft: false, ...FAST_POLL });

    expect(result.siteId).toBe('site_abc');
    expect(client.listSitesCalls).toBe(0);
    expect(client.createSiteCalls).toEqual([]);
    expect(client.createDeployCalls[0].siteId).toBe('site_abc');
  });

  it('finds an existing site by name on a later page → NO duplicate createSite', async () => {
    // The bug this guards: listSites() must be fully paginated upstream. Here we
    // hand resolveSite a 150-site list with the target deep in it; it must be
    // found by `find`, never re-created.
    const sites: NetlifySite[] = Array.from({ length: 150 }, (_, i) => ({
      id: `site_${i}`,
      name: `site-${i}`,
    }));
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      sites,
      deploy: { id: 'dep_1', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, {
      siteName: 'site-120',
      draft: false,
      ...FAST_POLL,
    });

    expect(result.siteId).toBe('site_120');
    expect(client.createSiteCalls).toEqual([]); // NOT duplicated
    expect(client.createDeployCalls[0].siteId).toBe('site_120');
  });

});

describe('executeDeploy — site creation', () => {
  it('creates a site by name when none matches', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      sites: [{ id: 'site_0', name: 'other' }],
      created: { id: 'site_made', name: 'fresh' },
      deploy: { id: 'dep_1', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteName: 'fresh', draft: false, ...FAST_POLL });

    expect(client.createSiteCalls).toEqual(['fresh']);
    expect(result.siteId).toBe('site_made');
  });

  it('creates an unnamed site when neither id nor name is given', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      created: { id: 'site_auto', name: 'auto-name' },
      deploy: { id: 'dep_1', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { draft: false, ...FAST_POLL });

    expect(client.listSitesCalls).toBe(0);
    expect(client.createSiteCalls).toEqual([undefined]);
    expect(result.siteId).toBe('site_auto');
  });
});

describe('executeDeploy — digest, upload, poll', () => {
  it('uploads nothing when Netlify reports required = []', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_x', state: 'building', required: [] },
      states: ['building', 'ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });

    // Exact digest payload crosses the boundary, draft flag preserved.
    expect(client.createDeployCalls[0].files).toEqual(digest.files);
    expect(client.createDeployCalls[0].draft).toBe(false);
    expect(client.uploadCalls).toHaveLength(0);
    expect(result.uploadedCount).toBe(0);
    expect(result.fileCount).toBe(2);
    expect(result.state).toBe('ready');
  });

  it('uploads exactly the required files with the right path + bytes', async () => {
    const digest = await makeSiteDigest();
    const indexSha = digest.files['/index.html'];
    const client = new FakeClient({
      deploy: { id: 'dep_up', state: 'building', required: [indexSha] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });

    expect(client.uploadCalls).toHaveLength(1);
    expect(client.uploadCalls[0].deployId).toBe('dep_up');
    expect(client.uploadCalls[0].deployPath).toBe('/index.html');
    expect(Buffer.from(client.uploadCalls[0].bytes).toString()).toBe('<h1>hi</h1>');
    expect(result.uploadedCount).toBe(1);
  });

  it('skips a required SHA1 that is not in the local digest', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_s', state: 'building', required: ['deadbeef-not-local'] },
      states: ['ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });

    expect(client.uploadCalls).toHaveLength(0);
    expect(result.uploadedCount).toBe(0);
  });

  it('polls past intermediate states until ready', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_p', state: 'building', required: [] },
      states: ['uploading', 'processing', 'ready'],
      ready: { ssl_url: 'https://s.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });

    expect(client.getDeployCalls).toBe(3);
    expect(result.state).toBe('ready');
  });

  it('throws [DEPLOY_FAILED] with the upstream error_message on a failure state', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_err', state: 'building', required: [] },
      states: ['building', 'error'],
      errorMessage: 'build script returned non-zero exit code',
    });

    await expect(
      executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL }),
    ).rejects.toThrow(/\[DEPLOY_FAILED\].*build script returned non-zero exit code/);
  });

  it('throws [DEPLOY_TIMEOUT] when the deploy never reaches ready', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_to', state: 'building', required: [] },
      states: ['building'], // repeats forever
    });

    await expect(
      executeDeploy(client, digest, { siteId: 's', draft: false, pollIntervalMs: 1, pollTimeoutMs: 5 }),
    ).rejects.toThrow(/\[DEPLOY_TIMEOUT\]/);
  });
});

describe('executeDeploy — URL selection', () => {
  it('prod deploy prefers ssl_url', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_prod', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://prod.netlify.app', deploy_ssl_url: 'https://abc--prod.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });

    expect(result.url).toBe('https://prod.netlify.app');
    expect(result.draft).toBe(false);
  });

  it('draft deploy prefers the per-deploy permalink (deploy_ssl_url)', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_draft', state: 'building', required: [] },
      states: ['ready'],
      ready: { ssl_url: 'https://prod.netlify.app', deploy_ssl_url: 'https://abc--prod.netlify.app' },
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: true, ...FAST_POLL });

    expect(client.createDeployCalls[0].draft).toBe(true);
    expect(result.url).toBe('https://abc--prod.netlify.app');
    expect(result.draft).toBe(true);
  });

  it('returns url=null when neither URL field is present', async () => {
    const digest = await makeSiteDigest();
    const client = new FakeClient({
      deploy: { id: 'dep_nourl', state: 'building', required: [] },
      states: ['ready'],
    });

    const result = await executeDeploy(client, digest, { siteId: 's', draft: false, ...FAST_POLL });
    expect(result.url).toBeNull();
  });
});

// ── Handler pre-flight guards (no network) ──────────────────────────────────

function fakeContext(token?: string): Parameters<typeof deploySite.handler>[1] {
  return {
    getUserSecrets: async () => (token ? { NETLIFY_TOKEN: token } : {}),
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof deploySite.handler>[1];
}

describe('deploy-site handler — pre-flight guards', () => {
  const prevEnv = process.env.MCA_WORKSPACE_PATH;

  beforeEach(() => {
    process.env.MCA_WORKSPACE_PATH = BASE;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MCA_WORKSPACE_PATH;
    else process.env.MCA_WORKSPACE_PATH = prevEnv;
  });

  it('throws [AUTH_REQUIRED] when no token is configured', async () => {
    mkdirSync(join(BASE, 'site'), { recursive: true });
    writeFileSync(join(BASE, 'site', 'index.html'), 'x');
    await expect(deploySite.handler({ dir: 'site' }, fakeContext())).rejects.toThrow(/\[AUTH_REQUIRED\]/);
  });

  it('throws [EMPTY_DIR] for a directory with no deployable files', async () => {
    mkdirSync(join(BASE, 'empty'), { recursive: true });
    await expect(deploySite.handler({ dir: 'empty' }, fakeContext('tok'))).rejects.toThrow(/\[EMPTY_DIR\]/);
  });

  it('throws [ROOT_DEPLOY_BLOCKED] when deploying the workspace root without confirmation', async () => {
    writeFileSync(join(BASE, 'index.html'), 'x'); // root has files, but it is the root
    await expect(deploySite.handler({ dir: '.' }, fakeContext('tok'))).rejects.toThrow(
      /\[ROOT_DEPLOY_BLOCKED\]/,
    );
  });

  it('bypasses the root guard with allowWorkspaceRoot:true (reaches the digest)', async () => {
    // Root is empty → if the guard is bypassed, the NEXT check (EMPTY_DIR) fires.
    // A different error code proves the root block did not trigger.
    await expect(
      deploySite.handler({ dir: '.', allowWorkspaceRoot: true }, fakeContext('tok')),
    ).rejects.toThrow(/\[EMPTY_DIR\]/);
  });
});
