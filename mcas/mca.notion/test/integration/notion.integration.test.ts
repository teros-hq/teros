import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolResponseShape,
  expectToolSuccess,
  SkipTracker,
  type McaTestEnvironment,
} from '@teros/mca-testing';

const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_REFRESH_TOKEN = process.env.NOTION_REFRESH_TOKEN;
const NOTION_ACCESS_TOKEN = process.env.NOTION_ACCESS_TOKEN;
const NOTION_TEST_PAGE_ID = process.env.NOTION_TEST_PAGE_ID;

if (!NOTION_CLIENT_ID || !NOTION_CLIENT_SECRET || !NOTION_REFRESH_TOKEN) {
  throw new Error(
    'Notion credentials required for integration tests. ' +
    'Set NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, NOTION_REFRESH_TOKEN ' +
    '(and optionally NOTION_ACCESS_TOKEN, NOTION_TEST_PAGE_ID) in .env.test.',
  );
}

let env: McaTestEnvironment;
const skipTracker = new SkipTracker(3);

function setNotionSecrets(): void {
  env.mockBackend.setSystemSecrets({
    CLIENT_ID: NOTION_CLIENT_ID!,
    CLIENT_SECRET: NOTION_CLIENT_SECRET!,
  });
  env.mockBackend.setUserSecrets({
    ACCESS_TOKEN: NOTION_ACCESS_TOKEN ?? '',
    REFRESH_TOKEN: NOTION_REFRESH_TOKEN!,
  });
}

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.notion' });
  await env.start();
  setNotionSecrets();
}, 120_000);

afterAll(async () => {
  await env.stop();
  skipTracker.assertNotTooManySkips();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
  setNotionSecrets();
});

// ─── Health Check with Real Credentials ────────────────────────────────────

describe('Health Check', () => {
  it('reports ready with valid OAuth credentials', async () => {
    const result = await env.mcaClient.callTool('-health-check', {});

    expect(result.success).toBe(true);
    const data = result.result as { status: string };
    expect(data.status).toBe('ready');
  }, 30_000);
});

// Token refresh test removed: MCA containers do not refresh tokens.
// Backend owns token refresh — MCA gets fresh access_token on next secret fetch.

// ─── Search ────────────────────────────────────────────────────────────────

describe('search', () => {
  it('searches workspace', async () => {
    const result = await env.mcaClient.callTool('search', {
      query: 'test',
      limit: 3,
    });

    expectToolSuccess(result);
    const data = result.result as { results?: unknown[] };
    expect(data.results).toBeDefined();
    expect(Array.isArray(data.results)).toBe(true);
  }, 30_000);
});

// ─── List Users ──────────────────────────────────────────────────────────

describe('list-users', () => {
  it('lists workspace users', async () => {
    const result = await env.mcaClient.callTool('list-users', { limit: 5 });

    expectToolSuccess(result);
    const data = result.result as { users?: unknown[] };
    expect(data.users).toBeDefined();
    expect(data.users!.length).toBeGreaterThan(0);
  }, 30_000);
});

// ─── Get Me ──────────────────────────────────────────────────────────────

describe('get-me', () => {
  it('returns the authenticated bot user', async () => {
    const result = await env.mcaClient.callTool('get-me', {});

    expectToolSuccess(result);
    const data = result.result as { id?: string; type?: string };
    expect(data.id).toBeTruthy();
    expect(data.type).toBe('bot');
  }, 15_000);
});

// ─── Page Operations (requires test page) ──────────────────────────────────

describe('Page Operations', () => {
  it('reads a page by ID', async () => {
    if (!NOTION_TEST_PAGE_ID) {
      skipTracker.skip('get-page', 'NOTION_TEST_PAGE_ID not set');
      return;
    }

    const result = await env.mcaClient.callTool('get-page', {
      pageId: NOTION_TEST_PAGE_ID,
    });

    expectToolSuccess(result);
    const data = result.result as { id?: string };
    expect(data.id).toBeTruthy();
  }, 30_000);

  it('reads page as markdown', async () => {
    if (!NOTION_TEST_PAGE_ID) {
      skipTracker.skip('get-page-markdown', 'NOTION_TEST_PAGE_ID not set');
      return;
    }

    const result = await env.mcaClient.callTool('get-page-markdown', {
      pageId: NOTION_TEST_PAGE_ID,
    });

    expectToolSuccess(result);
    const data = result.result as { markdown?: string };
    expect(data.markdown).toBeDefined();
  }, 30_000);

  it('creates and deletes a test page under test parent', async () => {
    if (!NOTION_TEST_PAGE_ID) {
      skipTracker.skip('create-and-archive-page', 'NOTION_TEST_PAGE_ID not set');
      return;
    }

    const createResult = await env.mcaClient.callTool('create-page', {
      parentPageId: NOTION_TEST_PAGE_ID,
      title: `[MCA Integration Test] ${Date.now()}`,
    });

    expectToolSuccess(createResult);
    const created = createResult.result as { id?: string };
    expect(created.id).toBeTruthy();

    if (created.id) {
      const archiveResult = await env.mcaClient.callTool('update-page', {
        pageId: created.id,
        archived: true,
      });
      expectToolSuccess(archiveResult);
    }
  }, 30_000);
});

// ─── Comments ──────────────────────────────────────────────────────────────

describe('list-comments', () => {
  it('lists comments on test page', async () => {
    if (!NOTION_TEST_PAGE_ID) {
      skipTracker.skip('list-comments', 'NOTION_TEST_PAGE_ID not set');
      return;
    }

    const result = await env.mcaClient.callTool('list-comments', {
      blockId: NOTION_TEST_PAGE_ID,
    });

    expectToolSuccess(result);
    const data = result.result as { comments?: unknown[] };
    expect(data.comments).toBeDefined();
  }, 15_000);
});
