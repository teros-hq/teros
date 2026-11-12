import type { ToolContext } from '@teros/mca-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { agentDirSuffix, agentOf, withGitCallScope } from './git-agent';
import {
  assertRemoteIsGithubHttps,
  getWorkspacePath,
  githubSlugFromUrl,
  oversizedBlobs,
  readOriginUrl,
  runGit,
  GITHUB_FILE_LIMIT_BYTES,
} from './git-local';
import { githubRequest } from './github-client';
import { resolveUserToken } from './github-user-token';
import { withRepoLock } from './repo-lock';
import { isWorkflowPath, workflowPermission } from './workflow-permission';

export type PrState = 'open' | 'merged' | 'closed' | 'none' | 'unknown';
export type PrStateFn = (owner: string, repo: string, branch: string) => Promise<PrState>;
export type PushFn = (repoPath: string, src: string, dst: string) => Promise<{ ok: boolean; error?: string }>;

export interface CleanupOptions {
  context?: ToolContext;
  prState?: PrStateFn;
  push?: PushFn;
  now?: Date;
  why?: string;
}

export interface CleanupResult {
  removed: boolean;
  savedBranches?: string[];
  reason?: string;
}

interface CloneState {
  lastUsed?: string;
  pushes?: Record<string, string>;
  kept?: { reason: string; at: string };
  due?: boolean;
}

export interface Tombstone {
  owner: string;
  repo: string;
  removedAt: string;
  savedBranches: string[];
}

const STATE_FILE = 'teros-cleanup.json';
const IN_PROGRESS: Array<[string, string]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
];
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API secret key'],
];
const ENV_FILE_RE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_TEMPLATE_RE = /(^|\/)\.env\.(example|sample|template)$/;

export function cloneTtlDays(): number {
  const n = Number(process.env.MCA_GIT_CLONE_TTL_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function saveWorkEnabled(): boolean {
  return process.env.MCA_GIT_SAVE_WORK !== '0';
}

function statePath(repoPath: string): string {
  return path.join(repoPath, '.git', STATE_FILE);
}

export function readCloneState(repoPath: string): CloneState {
  try {
    return JSON.parse(fs.readFileSync(statePath(repoPath), 'utf-8')) as CloneState;
  } catch {
    return {};
  }
}

function writeCloneState(repoPath: string, patch: Partial<CloneState>): void {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return;
  const next = { ...readCloneState(repoPath), ...patch };
  fs.writeFileSync(statePath(repoPath), JSON.stringify(next));
}

export function markCloneUsed(repoPath: string, when = new Date()): void {
  writeCloneState(repoPath, { lastUsed: when.toISOString(), due: false });
}

export function recordPush(repoPath: string, branch: string, sha: string): void {
  writeCloneState(repoPath, { pushes: { ...(readCloneState(repoPath).pushes ?? {}), [branch]: sha } });
}

function lastUsedMs(repoPath: string): number {
  const recorded = Date.parse(readCloneState(repoPath).lastUsed ?? '');
  if (Number.isFinite(recorded)) return recorded;
  let latest = 0;
  for (const f of ['index', 'HEAD', 'FETCH_HEAD']) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(repoPath, '.git', f)).mtimeMs);
    } catch {}
  }
  return latest;
}

export function tombstonePath(repoPath: string): string {
  return path.join(path.dirname(repoPath), `.${path.basename(repoPath)}.teros-removed.json`);
}

export function readTombstone(repoPath: string): Tombstone | null {
  try {
    return JSON.parse(fs.readFileSync(tombstonePath(repoPath), 'utf-8')) as Tombstone;
  } catch {
    return null;
  }
}

function slugOf(repoPath: string): { owner: string; repo: string } | null {
  const slug = githubSlugFromUrl(readOriginUrl(repoPath) ?? '');
  if (!slug) return null;
  const [owner, repo] = slug.split('/');
  return { owner, repo };
}

async function git(repoPath: string, args: string[]) {
  return runGit(repoPath, args);
}

function inProgressOperation(repoPath: string): string | undefined {
  return IN_PROGRESS.find(([f]) => fs.existsSync(path.join(repoPath, '.git', f)))?.[1];
}

async function onGitHub(repoPath: string, sha: string): Promise<boolean> {
  const r = await git(repoPath, ['branch', '-r', '--contains', sha]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export interface CloneAssessment {
  unsaved: string[];
  dirty: boolean;
  stashes: number;
  inProgress?: string;
  currentBranch: string | null;
  branchesToSave: string[];
  headToSave: boolean;
  changedPaths: string[];
}

export async function assessClone(repoPath: string, prState?: PrStateFn): Promise<CloneAssessment> {
  const unsaved: string[] = [];
  const status = await git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const lines = status.stdout.split('\n').filter(Boolean);
  const untracked = lines.filter((l) => l.startsWith('??')).length;
  const changed = lines.length - untracked;
  if (changed > 0) unsaved.push(`${changed} uncommitted change${changed === 1 ? '' : 's'}`);
  if (untracked > 0) unsaved.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`);
  const changedPaths = lines.map((l) => l.slice(3).replace(/^.* -> /, ''));

  const stashList = await git(repoPath, ['stash', 'list']);
  const stashes = stashList.stdout.split('\n').filter(Boolean).length;
  if (stashes > 0) unsaved.push(`${stashes} stash${stashes === 1 ? '' : 'es'}`);

  const inProgress = inProgressOperation(repoPath);
  if (inProgress) unsaved.push(`a ${inProgress} in progress`);

  const head = await git(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const currentBranch = head.code === 0 ? head.stdout.trim() : null;
  const slug = slugOf(repoPath);
  const pushes = readCloneState(repoPath).pushes ?? {};
  const branchesToSave: string[] = [];
  const refs = await git(repoPath, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads']);
  for (const line of refs.stdout.split('\n').filter(Boolean)) {
    const [branch, sha] = line.split('\t');
    if (await onGitHub(repoPath, sha)) continue;
    if (pushes[branch] === sha && prState && slug) {
      const state = await prState(slug.owner, slug.repo, branch).catch(() => 'unknown' as PrState);
      if (state === 'merged' || state === 'closed') continue;
    }
    const count = await git(repoPath, ['rev-list', '--count', sha, '--not', '--remotes']);
    const n = Number(count.stdout.trim()) || 1;
    unsaved.push(`branch ${branch} has ${n} commit${n === 1 ? '' : 's'} not on GitHub`);
    branchesToSave.push(branch);
  }
  let headToSave = false;
  if (!currentBranch) {
    const sha = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (sha && !(await onGitHub(repoPath, sha))) {
      unsaved.push('a detached HEAD with commits not on GitHub');
      headToSave = true;
    }
  }
  return {
    unsaved,
    dirty: lines.length > 0,
    stashes,
    inProgress,
    currentBranch,
    branchesToSave,
    headToSave,
    changedPaths,
  };
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

function refSafe(part: string): string {
  return part.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/\.\.+/g, '.').replace(/\/+/g, '/').replace(/^[-./]+|[-./]+$/g, '') || 'work';
}

function savedBranchName(agent: string, branch: string, now: Date): string {
  return `teros/saved/${refSafe(agent)}/${refSafe(branch)}-${stamp(now)}`;
}

async function scanForSecrets(repoPath: string, a: CloneAssessment): Promise<string | null> {
  const envFile = a.changedPaths.find((p) => ENV_FILE_RE.test(p) && !ENV_TEMPLATE_RE.test(p));
  if (envFile) return `${envFile} looks like an environment file with secrets`;
  const texts: string[] = [];
  texts.push((await git(repoPath, ['diff', 'HEAD'])).stdout);
  for (const p of a.changedPaths) {
    const file = path.join(repoPath, p);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size < 2 * 1024 * 1024) texts.push(fs.readFileSync(file, 'utf-8'));
    } catch {}
  }
  for (let i = 0; i < a.stashes; i++) texts.push((await git(repoPath, ['stash', 'show', '-p', `stash@{${i}}`])).stdout);
  for (const b of [...a.branchesToSave, ...(a.headToSave ? ['HEAD'] : [])]) {
    texts.push((await git(repoPath, ['log', '-p', '--format=', b, '--not', '--remotes'])).stdout);
    const names = (await git(repoPath, ['log', '--name-only', '--format=', b, '--not', '--remotes'])).stdout;
    const env = names.split('\n').find((n) => ENV_FILE_RE.test(n) && !ENV_TEMPLATE_RE.test(n));
    if (env) return `${env} looks like an environment file with secrets`;
  }
  for (const text of texts) {
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) return `it looks like it contains ${what}`;
  }
  return null;
}

async function workflowPaths(repoPath: string, a: CloneAssessment): Promise<string[]> {
  const paths = [...a.changedPaths];
  for (const b of [...a.branchesToSave, ...(a.headToSave ? ['HEAD'] : [])]) {
    paths.push(...(await git(repoPath, ['log', '--name-only', '--format=', b, '--not', '--remotes'])).stdout.split('\n'));
  }
  return paths.filter((p) => p && isWorkflowPath(p));
}

function defaultPush(context: ToolContext): PushFn {
  return async (repoPath, src, dst) => {
    try {
      await assertRemoteIsGithubHttps(repoPath, 'origin');
      const token = await resolveUserToken(context);
      const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
      const r = await runGit(repoPath, ['-c', `http.extraheader=${header}`, 'push', 'origin', `${src}:refs/heads/${dst}`]);
      return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
    }
  };
}

async function saveToBranches(
  repoPath: string,
  a: CloneAssessment,
  opts: CleanupOptions & { context: ToolContext },
): Promise<{ ok: true; branches: string[] } | { ok: false; reason: string }> {
  const slug = slugOf(repoPath);
  if (!slug) return { ok: false, reason: 'its origin is not a GitHub repository, so the work has nowhere to be saved' };
  const now = opts.now ?? new Date();
  const agent = agentOf(opts.context) ?? (path.basename(repoPath).split('@')[1] || 'agent');
  const why = opts.why ?? 'Teros removes clones that are no longer in use; this branch keeps the work that was not on GitHub yet.';

  const secret = await scanForSecrets(repoPath, a);
  if (secret) return { ok: false, reason: `the unsaved work was not pushed because ${secret}; check it and push or delete it by hand` };
  for (const p of a.changedPaths) {
    try {
      if (fs.statSync(path.join(repoPath, p)).size > GITHUB_FILE_LIMIT_BYTES) {
        return { ok: false, reason: `${p} is over GitHub's 100 MB limit, so the unsaved work cannot be pushed` };
      }
    } catch {}
  }
  for (const b of a.branchesToSave) {
    const big = await oversizedBlobs(repoPath, 'origin', b);
    if (big.length) return { ok: false, reason: `${big[0].path} is over GitHub's 100 MB limit, so branch ${b} cannot be pushed` };
  }
  const wf = await workflowPaths(repoPath, a);
  if (wf.length) {
    const perm = await workflowPermission(opts.context, slug.owner);
    if (perm.state === 'pending') {
      return { ok: false, reason: `the unsaved work changes ${wf[0]}, and the installation on ${slug.owner} has not accepted the Workflows permission yet` };
    }
  }

  const notes: string[] = [];
  let current = a.currentBranch;
  if (a.inProgress) {
    const abort = await git(repoPath, [a.inProgress, '--abort']);
    if (abort.code !== 0) return { ok: false, reason: `the ${a.inProgress} in progress could not be aborted to save the work` };
    notes.push(`A ${a.inProgress} was in progress; it was aborted before saving, so the commits are as they were before it started.`);
    const head = await git(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']);
    current = head.code === 0 ? head.stdout.trim() : null;
  }

  const plan: Array<{ src: string; dst: string }> = [];
  const label = current ?? 'detached';
  const afterAbort = a.inProgress ? await assessClone(repoPath) : a;
  if (afterAbort.dirty || afterAbort.stashes > 0) {
    const local = savedBranchName(agent, label, now);
    if ((await git(repoPath, ['checkout', '-q', '-b', local])).code !== 0) {
      return { ok: false, reason: 'a branch for the unsaved work could not be created' };
    }
    if (afterAbort.dirty) {
      await git(repoPath, ['add', '-A']);
      const message = `Saved by Teros: uncommitted work on ${label}\n\n${why}${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
      const c = await git(repoPath, ['commit', '-q', '--no-verify', '-m', message]);
      if (c.code !== 0) return { ok: false, reason: 'the uncommitted work could not be committed' };
    }
    for (let i = afterAbort.stashes - 1; i >= 0; i--) {
      const subject = (await git(repoPath, ['log', '-1', '--format=%s', `stash@{${i}}`])).stdout.trim();
      const tree = (await git(repoPath, ['rev-parse', `stash@{${i}}^{tree}`])).stdout.trim();
      const parent = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
      const msg = `Saved by Teros: stash@{${i}} (${subject})\n\n${why}`;
      const commit = await git(repoPath, ['commit-tree', tree, '-p', parent, '-m', msg]);
      if (commit.code !== 0) return { ok: false, reason: `stash@{${i}} could not be saved` };
      await git(repoPath, ['update-ref', `refs/heads/${local}`, commit.stdout.trim()]);
      const untracked = await git(repoPath, ['rev-parse', '-q', '--verify', `stash@{${i}}^3^{tree}`]);
      if (untracked.code === 0) {
        const extra = await git(repoPath, ['commit-tree', untracked.stdout.trim(), '-p', commit.stdout.trim(), '-m', `Saved by Teros: untracked files of stash@{${i}} (only those files)\n\n${why}`]);
        if (extra.code === 0) await git(repoPath, ['update-ref', `refs/heads/${local}`, extra.stdout.trim()]);
      }
    }
    plan.push({ src: `refs/heads/${local}`, dst: local });
  } else if (current && afterAbort.branchesToSave.includes(current) && notes.length) {
    const local = savedBranchName(agent, current, now);
    if ((await git(repoPath, ['checkout', '-q', '-b', local])).code !== 0) {
      return { ok: false, reason: 'a branch for the unsaved work could not be created' };
    }
    await git(repoPath, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `Saved by Teros: ${current} as it was\n\n${why}\n\n${notes.join('\n')}`]);
    plan.push({ src: `refs/heads/${local}`, dst: local });
  } else if (current && afterAbort.branchesToSave.includes(current)) {
    plan.push({ src: `refs/heads/${current}`, dst: savedBranchName(agent, current, now) });
  } else if (!current && afterAbort.headToSave) {
    plan.push({ src: 'HEAD', dst: savedBranchName(agent, 'detached', now) });
  }
  for (const b of afterAbort.branchesToSave) {
    if (b === current) continue;
    plan.push({ src: `refs/heads/${b}`, dst: savedBranchName(agent, b, now) });
  }

  for (const step of plan) {
    const big = await oversizedBlobs(repoPath, 'origin', step.src);
    if (big.length) return { ok: false, reason: `${big[0].path} is over GitHub's 100 MB limit; the work stays in this clone on ${step.dst}` };
  }

  const push = opts.push ?? defaultPush(opts.context);
  const pushed: string[] = [];
  for (const step of plan) {
    if (!step.dst.startsWith('teros/saved/')) return { ok: false, reason: `refused to push to ${step.dst}` };
    const r = await push(repoPath, step.src, step.dst);
    if (!r.ok) {
      return { ok: false, reason: `the push of the saved work to ${step.dst} failed (${r.error ?? 'unknown error'})${pushed.length ? `; already saved: ${pushed.join(', ')}` : ''}` };
    }
    pushed.push(step.dst);
  }
  return { ok: true, branches: pushed };
}

function registryPath(): string {
  return path.join(getWorkspacePath(), '.teros-github', 'saved-branches.json');
}

export function readSavedBranches(): Array<{ repo: string; branch: string; savedAt: string; url: string }> {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  } catch {
    return [];
  }
}

function remember(owner: string, repo: string, branches: string[], at: Date): void {
  if (!branches.length) return;
  const list = readSavedBranches();
  for (const branch of branches) {
    list.push({ repo: `${owner}/${repo}`, branch, savedAt: at.toISOString(), url: `https://github.com/${owner}/${repo}/tree/${branch}` });
  }
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(list.slice(-500), null, 2));
}

function removeClone(repoPath: string, savedBranches: string[], now: Date): void {
  const slug = slugOf(repoPath);
  fs.rmSync(repoPath, { recursive: true, force: true });
  if (slug) {
    const tomb: Tombstone = { owner: slug.owner, repo: slug.repo, removedAt: now.toISOString(), savedBranches };
    fs.writeFileSync(tombstonePath(repoPath), JSON.stringify(tomb));
    remember(slug.owner, slug.repo, savedBranches, now);
  }
  console.log(`[clone-cleanup] removed ${repoPath}${savedBranches.length ? `; unsaved work pushed to ${savedBranches.join(', ')}` : ''}`);
}

function keep(repoPath: string, reason: string, due = false): CleanupResult {
  writeCloneState(repoPath, { kept: { reason, at: new Date().toISOString() }, ...(due ? { due: true } : {}) });
  console.log(`[clone-cleanup] kept ${repoPath}: ${reason}`);
  return { removed: false, reason };
}

export async function cleanupClone(repoPath: string, opts: CleanupOptions = {}): Promise<CleanupResult> {
  if (!fs.existsSync(path.join(repoPath, '.git'))) return { removed: false, reason: 'it is not a git clone' };
  const now = opts.now ?? new Date();
  try {
    return await withRepoLock(
      repoPath,
      'clone-cleanup',
      async () => {
        const a = await assessClone(repoPath, opts.prState);
        if (a.unsaved.length === 0) {
          removeClone(repoPath, [], now);
          return { removed: true, savedBranches: [] };
        }
        const what = a.unsaved.join('; ');
        if (!saveWorkEnabled()) return keep(repoPath, `it holds unsaved work (${what}) and saving it to a branch is turned off`);
        if (!opts.context) {
          return keep(repoPath, `it holds unsaved work (${what}); it will be saved to a branch on origin on its agent's next GitHub call`, true);
        }
        const context = opts.context;
        const saved = await withGitCallScope(context, () => saveToBranches(repoPath, a, { ...opts, context }));
        if (!saved.ok) return keep(repoPath, saved.reason);
        removeClone(repoPath, saved.branches, now);
        return { removed: true, savedBranches: saved.branches };
      },
      { waitMs: 0 },
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('[GIT_LOCKED]')) {
      return { removed: false, reason: 'it is in use by another git command right now' };
    }
    throw e;
  }
}

function cloneDirs(filter?: (name: string) => boolean): string[] {
  const ws = getWorkspacePath();
  const out: string[] = [];
  let owners: string[] = [];
  try {
    owners = fs.readdirSync(ws, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  } catch {
    return out;
  }
  for (const owner of owners) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(path.join(ws, owner), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(ws, owner, name);
      if (filter && !filter(name)) continue;
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      if (!githubSlugFromUrl(readOriginUrl(dir) ?? '')) continue;
      out.push(dir);
    }
  }
  return out;
}

export async function sweepClones(opts: { now?: Date } = {}): Promise<CleanupResult[]> {
  const now = opts.now ?? new Date();
  const ttlMs = cloneTtlDays() * 24 * 60 * 60 * 1000;
  const results: CleanupResult[] = [];
  for (const dir of cloneDirs()) {
    if (now.getTime() - lastUsedMs(dir) < ttlMs) continue;
    results.push(await cleanupClone(dir, { now, why: `Teros removes clones nobody used for ${cloneTtlDays()} days; this branch keeps the work that was not on GitHub yet.` }));
  }
  return results;
}

export function githubPrState(context: ToolContext): PrStateFn {
  return async (owner, repo, branch) => {
    try {
      const pulls = (await githubRequest(context, `/repos/${owner}/${repo}/pulls`, {
        params: { head: `${owner}:${branch}`, state: 'all', per_page: 1 },
      })) as Array<{ state?: string; merged_at?: string | null }>;
      const pr = pulls?.[0];
      if (!pr) return 'none';
      if (pr.merged_at) return 'merged';
      return pr.state === 'closed' ? 'closed' : 'open';
    } catch {
      return 'unknown';
    }
  };
}

export async function runAgentCleanup(
  context: ToolContext,
  opts: { push?: PushFn; prState?: PrStateFn; now?: Date; agentId?: string; all?: boolean } = {},
): Promise<CleanupResult[]> {
  const agentId = opts.agentId ?? agentOf(context);
  if (!agentId) return [];
  const suffix = `@${agentDirSuffix(agentId)}`;
  const now = opts.now ?? new Date();
  const ttlMs = cloneTtlDays() * 24 * 60 * 60 * 1000;
  const prState = opts.prState ?? githubPrState(context);
  const results: CleanupResult[] = [];
  for (const dir of cloneDirs((name) => name.endsWith(suffix))) {
    const state = readCloneState(dir);
    let reason: string | undefined;
    if (opts.all) reason = 'Teros removes the clones of an agent that was deleted or lost GitHub';
    else if (state.due || now.getTime() - lastUsedMs(dir) >= ttlMs) reason = `Teros removes clones nobody used for ${cloneTtlDays()} days`;
    else {
      const slug = slugOf(dir);
      const branches = Object.keys(state.pushes ?? {});
      if (slug && branches.length) {
        const states = await Promise.all(branches.map((b) => prState(slug.owner, slug.repo, b)));
        if (states.every((s) => s === 'merged' || s === 'closed') && (await assessClone(dir, prState)).unsaved.length === 0) {
          reason = 'Teros removes a clone once its pull requests are merged or closed';
        }
      }
    }
    if (!reason) continue;
    results.push(await cleanupClone(dir, { context, prState, push: opts.push, now, why: `${reason}; this branch keeps the work that was not on GitHub yet.` }));
  }
  return results;
}

const lastAgentRun = new Map<string, number>();
const AGENT_CLEANUP_EVERY_MS = 10 * 60 * 1000;

export function scheduleAgentCleanup(context: ToolContext): void {
  if (process.env.MCA_GIT_CLEANUP_AFTER_CALLS === '0') return;
  const agentId = agentOf(context);
  if (!agentId) return;
  const now = Date.now();
  if (now - (lastAgentRun.get(agentId) ?? 0) < AGENT_CLEANUP_EVERY_MS) return;
  lastAgentRun.set(agentId, now);
  setTimeout(() => {
    runAgentCleanup(context).catch((e) => console.log(`[clone-cleanup] agent cleanup failed: ${e instanceof Error ? e.message : e}`));
  }, 2_000).unref?.();
}

export function writeKeptShown(repoPath: string): void {
  const next = { ...readCloneState(repoPath) };
  delete next.kept;
  fs.writeFileSync(statePath(repoPath), JSON.stringify(next));
}

export function cleanupNoteFor(repoPath: string): string | undefined {
  const kept = readCloneState(repoPath).kept;
  return kept ? `Kept by the automatic cleanup because ${kept.reason} (${kept.at.slice(0, 16).replace('T', ' ')} UTC).` : undefined;
}

export function restoredNote(t: Tombstone): string {
  const when = t.removedAt.slice(0, 16).replace('T', ' ');
  return t.savedBranches.length
    ? `Your unsaved work from ${when} UTC was saved to branch ${t.savedBranches.join(', ')} on origin before this clone was removed; the clone has just been cloned again from GitHub. Look at that branch before redoing work.`
    : `This clone was removed by the automatic cleanup on ${when} UTC (nothing unsaved in it) and has just been cloned again from GitHub.`;
}
