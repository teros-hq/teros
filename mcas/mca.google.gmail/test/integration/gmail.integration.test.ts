import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createMcaTestEnv,
  expectToolResponseShape,
  expectToolSuccess,
  SkipTracker,
  type McaTestEnvironment,
} from '@teros/mca-testing';

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REDIRECT_URIS = process.env.GMAIL_REDIRECT_URIS;
const GMAIL_ACCESS_TOKEN = process.env.GMAIL_ACCESS_TOKEN;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_EMAIL = process.env.GMAIL_EMAIL;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
  throw new Error(
    'Gmail credentials required for integration tests. ' +
    'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN ' +
    '(and optionally GMAIL_ACCESS_TOKEN, GMAIL_EMAIL) in .env.test.',
  );
}

let env: McaTestEnvironment;
const skipTracker = new SkipTracker(3);

function setGmailSecrets(): void {
  env.mockBackend.setSystemSecrets({
    CLIENT_ID: GMAIL_CLIENT_ID!,
    CLIENT_SECRET: GMAIL_CLIENT_SECRET!,
    REDIRECT_URIS: GMAIL_REDIRECT_URIS ?? 'http://localhost/callback',
  });
  env.mockBackend.setUserSecrets({
    ACCESS_TOKEN: GMAIL_ACCESS_TOKEN ?? '',
    REFRESH_TOKEN: GMAIL_REFRESH_TOKEN!,
    EMAIL: GMAIL_EMAIL ?? '',
    EXPIRY_DATE: '0',
  });
}

beforeAll(async () => {
  env = createMcaTestEnv({ mcaId: 'mca.google.gmail' });
  await env.start();
  setGmailSecrets();
}, 120_000);

afterAll(async () => {
  await env.stop();
  skipTracker.assertNotTooManySkips();
}, 30_000);

beforeEach(() => {
  env.mockBackend.reset();
  setGmailSecrets();
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

// Token refresh test removed: Gmail MCA explicitly does NOT refresh tokens.
// See mca.google.gmail/src/index.ts — "El contenedor NO refresca por su cuenta."
// createGmailClient only sets access_token, never refresh_token.
// Backend owns token refresh (TER-388).

// ─── List Messages ─────────────────────────────────────────────────────────

describe('list-messages', () => {
  it('lists messages from inbox', async () => {
    const result = await env.mcaClient.callTool('list-messages', {
      maxResults: 5,
    });

    expectToolSuccess(result);
    const data = result.result as { messages?: unknown[] };
    expect(data.messages).toBeDefined();
    expect(Array.isArray(data.messages)).toBe(true);
  }, 30_000);

  it('lists unread messages', async () => {
    const result = await env.mcaClient.callTool('list-messages', {
      maxResults: 5,
      query: 'is:unread',
    });

    expectToolResponseShape(result, { messages: 'array' });
  }, 30_000);
});

// ─── Search Messages ───────────────────────────────────────────────────────

describe('search-messages', () => {
  it('searches with Gmail query syntax', async () => {
    const result = await env.mcaClient.callTool('search-messages', {
      query: 'newer_than:7d',
      maxResults: 3,
    });

    expectToolResponseShape(result, { messages: 'array' });
  }, 30_000);
});

// ─── Get Message ───────────────────────────────────────────────────────────

describe('get-message', () => {
  it('fetches a specific message by ID', async () => {
    // First list to get a real message ID
    const listResult = await env.mcaClient.callTool('list-messages', {
      maxResults: 1,
    });

    expectToolSuccess(listResult);
    const listData = listResult.result as { messages?: { id: string }[] };

    if (!listData.messages?.length) {
      skipTracker.skip('get-message', 'inbox empty');
      return;
    }

    const msgId = listData.messages[0].id;
    const result = await env.mcaClient.callTool('get-message', { messageId: msgId });

    expectToolSuccess(result);
    const data = result.result as { id?: string; subject?: string };
    expect(data.id).toBe(msgId);
  }, 30_000);
});

// ─── Labels ────────────────────────────────────────────────────────────────

describe('list-labels', () => {
  it('lists Gmail labels', async () => {
    const result = await env.mcaClient.callTool('list-labels', {});

    expectToolSuccess(result);
    const data = result.result as { labels?: { name: string }[] };
    expect(data.labels).toBeDefined();
    expect(data.labels!.length).toBeGreaterThan(0);
  }, 15_000);
});

// ─── Drafts ────────────────────────────────────────────────────────────────

describe('Drafts', () => {
  let testDraftId: string | null = null;

  it('creates a draft', async () => {
    const result = await env.mcaClient.callTool('create-draft', {
      to: GMAIL_EMAIL ?? 'test@example.com',
      subject: `[MCA Integration Test] ${Date.now()}`,
      body: 'This draft was created by automated integration tests. Safe to delete.',
    });

    expectToolSuccess(result);
    const data = result.result as { draftId?: string };
    expect(data.draftId).toBeTruthy();
    testDraftId = data.draftId ?? null;
  }, 30_000);

  it('lists drafts', async () => {
    const result = await env.mcaClient.callTool('list-drafts', {});
    expectToolSuccess(result);
  }, 15_000);

  it('deletes the test draft', async () => {
    if (!testDraftId) {
      skipTracker.skip('delete-draft', 'no test draft created');
      return;
    }

    const result = await env.mcaClient.callTool('delete-draft', {
      draftId: testDraftId,
    });

    expectToolSuccess(result);
    testDraftId = null;
  }, 15_000);
});

// ─── Send Email (self-send) ────────────────────────────────────────────────

describe('send-message', () => {
  it('sends an email to self', async () => {
    if (!GMAIL_EMAIL) {
      skipTracker.skip('send-message', 'GMAIL_EMAIL not set');
      return;
    }

    const result = await env.mcaClient.callTool('send-message', {
      to: GMAIL_EMAIL,
      subject: `[MCA Integration Test] ${Date.now()}`,
      body: 'Automated integration test email. Safe to delete.',
    });

    expectToolSuccess(result);
    const data = result.result as { messageId?: string };
    expect(data.messageId).toBeTruthy();
  }, 30_000);
});

// ─── Email Watcher ─────────────────────────────────────────────────────────

describe('Email Watcher', () => {
  it('starts watcher, checks status, then stops', async () => {
    const startResult = await env.mcaClient.callTool('start-email-watcher', {
      intervalMinutes: 5,
    });

    const startData = startResult.result as { success: boolean };
    expect(startData.success).toBe(true);

    const statusResult = await env.mcaClient.callTool('get-watcher-status', {});
    expect(statusResult.success).toBe(true);
    const statusData = statusResult.result as { active: boolean };
    expect(statusData.active).toBe(true);

    const stopResult = await env.mcaClient.callTool('stop-email-watcher', {});
    expect(stopResult.success).toBe(true);
    const stopData = stopResult.result as { success: boolean };
    expect(stopData.success).toBe(true);
  }, 30_000);
});
