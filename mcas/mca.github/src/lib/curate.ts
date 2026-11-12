import type { ToolContext } from '@teros/mca-sdk';
import { githubRequest } from './github-client';

type Obj = Record<string, unknown>;

const BODY_EXCERPT_CHARS = 300;
const PATCH_EXCERPT_CHARS = 1_500;
const MESSAGE_EXCERPT_CHARS = 500;

export function excerpt(value: unknown, max: number): string | null | undefined {
  if (typeof value !== 'string') return value as null | undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function pick(o: unknown, keys: string[]): Obj | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const out: Obj = {};
  for (const k of keys) {
    const v = (o as Obj)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function compact(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

export const curateUser = (u: unknown) => pick(u, ['login']);

function curateLabels(labels: unknown): unknown {
  return Array.isArray(labels) ? labels.map((l) => (typeof l === 'string' ? l : (l as Obj)?.name)) : undefined;
}

export function curateIssue(i: Obj): Obj {
  return compact({
    ...pick(i, ['number', 'title', 'state', 'state_reason', 'comments', 'html_url', 'updated_at']),
    user: curateUser(i.user),
    labels: curateLabels(i.labels),
    assignees: Array.isArray(i.assignees) ? i.assignees.map(curateUser) : undefined,
    ...(i.pull_request ? { is_pull_request: true } : {}),
  });
}

export function curatePull(p: Obj): Obj {
  const ref = (r: unknown) => pick(r, ['ref', 'sha']);
  return compact({
    ...pick(p, ['number', 'title', 'state', 'draft', 'merged_at', 'html_url', 'updated_at']),
    user: curateUser(p.user),
    head: ref(p.head),
    base: ref(p.base),
    labels: curateLabels(p.labels),
    requested_reviewers: Array.isArray(p.requested_reviewers) ? p.requested_reviewers.map(curateUser) : undefined,
  });
}

export function curateCommit(c: Obj): Obj {
  const commit = c.commit as Obj | undefined;
  return {
    sha: c.sha,
    html_url: c.html_url,
    commit: commit
      ? {
          message: excerpt(commit.message, MESSAGE_EXCERPT_CHARS),
          author: pick(commit.author, ['name', 'email', 'date']),
          committer: pick(commit.committer, ['name', 'email', 'date']),
        }
      : undefined,
    author: curateUser(c.author),
  };
}

export const curateBranch = (b: Obj): Obj => ({
  name: b.name,
  protected: b.protected,
  commit: pick(b.commit, ['sha']),
});

export const curateRelease = (r: Obj): Obj => ({
  ...pick(r, ['id', 'tag_name', 'name', 'draft', 'prerelease', 'html_url', 'published_at', 'created_at', 'target_commitish']),
  author: curateUser(r.author),
  body: excerpt(r.body, BODY_EXCERPT_CHARS),
  assets: Array.isArray(r.assets) ? r.assets.map((a) => pick(a, ['name', 'size', 'browser_download_url'])) : undefined,
});

export function curateFileChange(f: Obj): Obj {
  const patch = typeof f.patch === 'string' ? f.patch : undefined;
  return {
    ...pick(f, ['filename', 'status', 'additions', 'deletions', 'changes', 'previous_filename', 'sha', 'blob_url']),
    ...(patch !== undefined ? { patch: excerpt(patch, PATCH_EXCERPT_CHARS) } : {}),
    ...(patch && patch.length > PATCH_EXCERPT_CHARS ? { patch_truncated: true } : {}),
  };
}

export const curateReviewComment = (c: Obj): Obj => ({
  ...pick(c, ['id', 'path', 'line', 'original_line', 'side', 'commit_id', 'in_reply_to_id', 'html_url', 'created_at', 'updated_at']),
  user: curateUser(c.user),
  body: excerpt(c.body, 1_000),
  diff_hunk: excerpt(c.diff_hunk, 400),
});

export const curateWorkflow = (w: Obj): Obj =>
  pick(w, ['id', 'name', 'path', 'state', 'html_url', 'updated_at']) ?? {};

export const curateRun = (r: Obj): Obj => ({
  ...pick(r, [
    'id', 'name', 'display_title', 'status', 'conclusion', 'run_number', 'run_attempt', 'event',
    'head_branch', 'head_sha', 'html_url', 'created_at', 'updated_at', 'run_started_at', 'workflow_id',
  ]),
  actor: curateUser(r.actor),
});

export const curateJob = (j: Obj): Obj => ({
  ...pick(j, ['id', 'name', 'status', 'conclusion', 'started_at', 'completed_at', 'html_url', 'runner_name']),
  steps: Array.isArray(j.steps) ? j.steps.map((s) => pick(s, ['number', 'name', 'status', 'conclusion'])) : undefined,
});

export const curateCodeItem = (c: Obj): Obj => ({
  ...pick(c, ['name', 'path', 'sha', 'html_url']),
  repository: pick(c.repository, ['full_name', 'private']),
});

export function curateRepo(r: Obj): Obj {
  return {
    ...pick(r, [
      'id', 'name', 'full_name', 'private', 'visibility', 'description', 'default_branch', 'language',
      'stargazers_count', 'forks_count', 'open_issues_count', 'archived', 'fork', 'pushed_at', 'updated_at', 'html_url',
    ]),
    owner: pick(r.owner, ['login', 'avatar_url']),
  };
}

export function hasNextPage(linkHeader: string | null | undefined): boolean {
  return !!linkHeader && /<[^>]+>;\s*rel="next"/.test(linkHeader);
}

export interface PageArgs {
  page?: number;
  per_page?: number;
}

export const PAGE_PARAMS = {
  per_page: { type: 'number', description: 'Results per page (default: 30, max: 100).' },
  page: { type: 'number', description: 'Page number, 1-based (default: 1). Use it when has_next_page is true.' },
} as const;

export const PAGED_RESULT_NOTE =
  'Returns {items, page, per_page, has_next_page}: trimmed fields (long texts cut to an excerpt); call again with page+1 while has_next_page is true.';

export interface PagedResult {
  items: Obj[];
  page: number;
  per_page: number;
  has_next_page: boolean;
  total_count?: number;
  [extra: string]: unknown;
}

export async function pagedRequest(
  context: ToolContext,
  path: string,
  args: PageArgs,
  params: Record<string, string | number | boolean | undefined>,
  extract: (payload: unknown) => { items: unknown[]; total_count?: number },
  curate: (item: Obj) => Obj,
): Promise<PagedResult> {
  const page = args.page && args.page > 0 ? Math.floor(args.page) : 1;
  const perPage = args.per_page && args.per_page > 0 ? Math.min(Math.floor(args.per_page), 100) : 30;
  let link: string | null = null;
  const payload = await githubRequest(context, path, {
    params: { ...params, per_page: perPage, page },
    onResponse: (r) => {
      link = r.headers.get('link');
    },
  });
  const { items, total_count } = extract(payload);
  return {
    items: items.map((i) => curate(i as Obj)),
    page,
    per_page: perPage,
    has_next_page: hasNextPage(link),
    ...(total_count !== undefined ? { total_count } : {}),
  };
}

export const arrayPayload = (p: unknown) => ({ items: Array.isArray(p) ? p : [] });

export const fieldPayload = (field: string) => (p: unknown) => {
  const o = (p ?? {}) as Obj;
  return {
    items: Array.isArray(o[field]) ? (o[field] as unknown[]) : [],
    total_count: typeof o.total_count === 'number' ? o.total_count : undefined,
  };
};
