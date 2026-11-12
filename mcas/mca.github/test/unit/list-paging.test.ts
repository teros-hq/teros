import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getFileContent } from '../../src/tools';
import { REST_TOOLS } from '../../src/tools/rest-tools';

const ctx = {
  getUserSecrets: async () => ({ USER_ACCESS_TOKEN: 'ghu_list_paging_token_123456', USER_LOGIN: 'octo' }),
  getSystemSecrets: async () => ({ GITHUB_APP_SLUG: 'teros' }),
} as never;

const bigUser = (login: string) => ({
  login,
  id: 1,
  node_id: 'MDQ6VXNlcjE=',
  avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`,
  gravatar_id: '',
  url: `https://api.github.com/users/${login}`,
  html_url: `https://github.com/${login}`,
  followers_url: `https://api.github.com/users/${login}/followers`,
  following_url: `https://api.github.com/users/${login}/following{/other_user}`,
  gists_url: `https://api.github.com/users/${login}/gists{/gist_id}`,
  starred_url: `https://api.github.com/users/${login}/starred{/owner}{/repo}`,
  subscriptions_url: `https://api.github.com/users/${login}/subscriptions`,
  organizations_url: `https://api.github.com/users/${login}/orgs`,
  repos_url: `https://api.github.com/users/${login}/repos`,
  events_url: `https://api.github.com/users/${login}/events{/privacy}`,
  received_events_url: `https://api.github.com/users/${login}/received_events`,
  type: 'User',
  site_admin: false,
});

function bigIssue(n: number, pull = false) {
  return {
    url: `https://api.github.com/repos/acme/api/issues/${n}`,
    repository_url: 'https://api.github.com/repos/acme/api',
    labels_url: `https://api.github.com/repos/acme/api/issues/${n}/labels{/name}`,
    comments_url: `https://api.github.com/repos/acme/api/issues/${n}/comments`,
    events_url: `https://api.github.com/repos/acme/api/issues/${n}/events`,
    html_url: `https://github.com/acme/api/issues/${n}`,
    id: 1000 + n,
    node_id: 'I_kwDOAAAAAA',
    number: n,
    title: `Seed issue ${n}`,
    user: bigUser('octo'),
    labels: [{ id: 1, node_id: 'LA_x', url: 'https://api.github.com/x', name: 'bug', color: 'd73a4a', default: true, description: "Something isn't working" }],
    state: 'open',
    locked: false,
    assignee: bigUser('octo'),
    assignees: [bigUser('octo')],
    milestone: null,
    comments: 2,
    created_at: '2026-10-27T00:00:00Z',
    updated_at: '2026-10-27T00:00:00Z',
    closed_at: null,
    author_association: 'OWNER',
    body: 'Long body '.repeat(200),
    reactions: { url: 'x', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `https://api.github.com/repos/acme/api/issues/${n}/timeline`,
    state_reason: null,
    ...(pull ? { pull_request: { url: 'x', html_url: `https://github.com/acme/api/pull/${n}` } } : {}),
  };
}

let calls: string[] = [];
let respond: (url: string) => { body: unknown; link?: string };
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const r = respond(url);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...(r.link ? { link: r.link } : {}) },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const NEXT = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=4>; rel="last"';

describe('list tools return curated, pageable results (005)', () => {
  it('list-issues: 100 issues fit in a small payload, say there is a next page, and leave PRs out', async () => {
    respond = () => ({ body: [...Array.from({ length: 99 }, (_, i) => bigIssue(i + 1)), bigIssue(500, true)], link: NEXT });
    const result = (await REST_TOOLS['list-issues'].handler({ owner: 'acme', repo: 'api', per_page: 100 }, ctx)) as {
      items: Array<{ number: number }>;
      has_next_page: boolean;
      page: number;
    };
    expect(JSON.stringify(result, null, 2).length).toBeLessThan(40_000);
    expect(result.has_next_page).toBe(true);
    expect(result.page).toBe(1);
    expect(result.items.some((i) => i.number === 500)).toBe(false);
  });

  it('list-issues {page: 2} asks GitHub for page 2', async () => {
    respond = () => ({ body: [bigIssue(1)] });
    const result = (await REST_TOOLS['list-issues'].handler({ owner: 'acme', repo: 'api', page: 2 }, ctx)) as {
      has_next_page: boolean;
    };
    expect(calls[0]).toContain('page=2');
    expect(result.has_next_page).toBe(false);
  });

  const LISTS: Array<[string, Record<string, unknown>, unknown]> = [
    ['list-pulls', { owner: 'acme', repo: 'api' }, [{ number: 1, title: 't', state: 'open', user: bigUser('o'), head: { ref: 'a', sha: '1' }, base: { ref: 'main', sha: '2' }, body: 'x'.repeat(5000) }]],
    ['list-commits', { owner: 'acme', repo: 'api' }, [{ sha: 'abc', commit: { message: 'm', author: { name: 'a', email: 'e', date: 'd' } }, author: bigUser('o') }]],
    ['list-branches', { owner: 'acme', repo: 'api' }, [{ name: 'main', commit: { sha: 'abc', url: 'u' }, protected: false }]],
    ['list-releases', { owner: 'acme', repo: 'api' }, [{ id: 1, tag_name: 'v1', name: 'v1', draft: false, prerelease: false, body: 'b'.repeat(5000), assets: [] }]],
    ['list-pr-files', { owner: 'acme', repo: 'api', pull_number: 1 }, [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '+x\n'.repeat(5000) }]],
    ['list-pr-commits', { owner: 'acme', repo: 'api', pull_number: 1 }, [{ sha: 'abc', commit: { message: 'm' } }]],
    ['list-pr-review-comments', { owner: 'acme', repo: 'api', pull_number: 1 }, [{ id: 1, body: 'b', path: 'a.ts', diff_hunk: '@@'.repeat(2000), user: bigUser('o') }]],
    ['list-workflows', { owner: 'acme', repo: 'api' }, { total_count: 1, workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] }],
    ['list-workflow-runs', { owner: 'acme', repo: 'api' }, { total_count: 1, workflow_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'success', head_commit: { message: 'x'.repeat(4000) }, repository: { big: 'y'.repeat(4000) } }] }],
    ['list-workflow-run-jobs', { owner: 'acme', repo: 'api', run_id: 1 }, { total_count: 1, jobs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', steps: [] }] }],
    ['search-issues', { q: 'repo:acme/api bug' }, { total_count: 1, incomplete_results: false, items: [bigIssue(1)] }],
    ['search-code', { query: 'addClass repo:acme/api' }, { total_count: 1, items: [{ name: 'a.js', path: 'src/a.js', sha: 's', repository: { full_name: 'acme/api', big: 'y'.repeat(4000) } }] }],
    ['search-repos', { query: 'teros' }, { total_count: 1, items: [{ name: 'api', full_name: 'acme/api', private: false, owner: bigUser('acme') }] }],
  ];

  for (const [name, args, body] of LISTS) {
    it(`${name}: forwards page, returns {items, page, per_page, has_next_page}, trims the payload`, async () => {
      respond = () => ({ body, link: NEXT });
      const result = (await REST_TOOLS[name].handler({ ...args, page: 3, per_page: 10 }, ctx)) as Record<string, unknown>;
      expect(calls[0]).toContain('page=3');
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.page).toBe(3);
      expect(result.per_page).toBe(10);
      expect(result.has_next_page).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThan(4_000);
    });
  }
});

describe('get-file-content handles big and binary files (011)', () => {
  it('a 1–100 MB file is fetched raw instead of coming back empty', async () => {
    respond = (url) =>
      url.includes('/contents/') && !calls.some((c, i) => i > 0 && c === url)
        ? { body: { name: 'big.txt', path: 'notes/big.txt', sha: 's', size: 1_200_000, encoding: 'none', content: '', type: 'file' } }
        : { body: 'line\n'.repeat(240_000) };
    let raw = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const accept = new Headers(init?.headers).get('accept') ?? '';
      if (accept.includes('raw')) {
        raw++;
        return new Response('line\n'.repeat(240_000), { status: 200 });
      }
      return new Response(
        JSON.stringify({ name: 'big.txt', path: 'notes/big.txt', sha: 's', size: 1_200_000, encoding: 'none', content: '', type: 'file' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const result = (await getFileContent.handler({ owner: 'acme', repo: 'api', path: 'notes/big.txt' }, ctx)) as {
      decoded_content?: string;
      truncated?: boolean;
    };
    expect(raw).toBe(1);
    expect((result.decoded_content ?? '').length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it('a binary file comes back as base64 only, flagged binary', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).toString('base64');
    respond = () => ({ body: { name: 'logo.png', path: 'logo.png', sha: 's', size: 12, encoding: 'base64', content: png, type: 'file' } });
    const result = (await getFileContent.handler({ owner: 'acme', repo: 'api', path: 'logo.png' }, ctx)) as Record<string, unknown>;
    expect(result.binary).toBe(true);
    expect(result.decoded_content).toBeUndefined();
    expect(result.content).toBe(png);
  });

  it('a text file is returned once, decoded', async () => {
    respond = () => ({
      body: { name: 'a.md', path: 'a.md', sha: 's', size: 6, encoding: 'base64', content: Buffer.from('# hi\n').toString('base64'), type: 'file' },
    });
    const result = (await getFileContent.handler({ owner: 'acme', repo: 'api', path: 'a.md' }, ctx)) as Record<string, unknown>;
    expect(result.decoded_content).toBe('# hi\n');
    expect(result.content).toBeUndefined();
  });
});

describe('list-repos counts and pages per owner (005)', () => {
  it('owner filter picks the installation first, so total_count and has_next_page are real', async () => {
    respond = (url) => {
      if (url.includes('/user/installations?')) {
        return {
          body: {
            installations: [
              { id: 1, account: { login: 'acme' } },
              { id: 2, account: { login: 'other' } },
            ],
          },
        };
      }
      return { body: { total_count: 250, repositories: [{ name: 'api', full_name: 'acme/api', private: true, owner: { login: 'acme' } }] } };
    };
    const result = (await REST_TOOLS['list-repos'].handler({ owner: 'acme', per_page: 100 }, ctx)) as {
      total_count: number;
      has_next_page: boolean;
    };
    expect(calls.some((c) => c.includes('/user/installations/2/'))).toBe(false);
    expect(result.total_count).toBe(250);
    expect(result.has_next_page).toBe(true);
  });

  it('no installation at all says so, with the install link', async () => {
    respond = () => ({ body: { installations: [] } });
    const result = (await REST_TOOLS['list-repos'].handler({}, ctx)) as { note?: string };
    expect(result.note).toContain('github.com/apps/teros/installations/new');
  });
});
