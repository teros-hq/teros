/**
 * Notion API Client Manager
 *
 * Stateless: credentials are read from `context` on every `getNotionClient`
 * call. A custom `fetch` is injected into the Notion SDK — on 401 it refreshes
 * the access token via Notion's OAuth `refresh_token` grant and retries once
 * with the fresh `Authorization` header. Refreshed credentials are persisted
 * to the backend via `context.updateUserSecrets`, so subsequent tool calls
 * (in this or any other worker) read the rotated token.
 *
 * Pattern from `mca.canva/lib/canva-client.ts` and `mca.figma/lib/figma-client.ts`.
 *
 * Why a fetch hook (not a per-call wrapper):
 *   - The SDK exposes `fetch?: SupportedFetch` in ClientOptions
 *     (https://github.com/makenotion/notion-sdk-js/blob/main/src/Client.ts).
 *   - 38 tools call the SDK directly (`client.databases.update`, etc.); a hook
 *     intercepts every request without touching call sites.
 *   - `retry: false` on the SDK leaves all retry policy to `wrapNotionCall`.
 */

import { Client } from '@notionhq/client';
import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';
import { NotionApiError } from './_notion-error';

// The Notion SDK's `SupportedFetch` is not re-exported from the package root in
// v5.20; we mirror its shape locally to stay loosely coupled to the SDK's
// internal type tree. The cast at the Client constructor below is the only
// place we lose strictness.
type NotionFetchInit = {
  headers?: Record<string, string>;
  body?: string | FormData;
  method?: string;
};
type NotionFetch = (url: string, init?: NotionFetchInit) => Promise<Response>;

const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';

export interface NotionSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  EXPIRY_DATE?: string;
}

async function loadNotionSecrets(context: ToolContext): Promise<NotionSecrets> {
  const [systemSecrets, userSecrets] = await Promise.all([
    context.getSystemSecrets(),
    context.getUserSecrets(),
  ]);
  return { ...systemSecrets, ...userSecrets } as NotionSecrets;
}

async function refreshNotionAccessToken(
  context: ToolContext,
  secrets: NotionSecrets,
): Promise<string> {
  const { CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN } = secrets;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new NotionApiError({
      code: 'SYSTEM_CONFIG_MISSING',
      action: {
        type: 'admin_action',
        description: 'Configure Notion CLIENT_ID and CLIENT_SECRET in system secrets.',
      },
      message: 'Notion OAuth CLIENT_ID and CLIENT_SECRET not configured.',
    });
  }
  if (!REFRESH_TOKEN) {
    throw new NotionApiError({
      code: 'AUTH_REQUIRED',
      action: {
        type: 'user_action',
        description: 'Reconnect your Notion account via OAuth.',
      },
      message: 'No Notion refresh token available. Reconnect required.',
    });
  }

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const response = await fetch(NOTION_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // 400/401 from the token endpoint = refresh token rejected (revoked,
    // expired, or tampered). Surface as AUTH_EXPIRED so the agent prompts
    // the user to reconnect rather than auto-retrying.
    if (response.status === 400 || response.status === 401) {
      throw new NotionApiError({
        code: 'AUTH_EXPIRED',
        action: {
          type: 'user_action',
          description: 'Reconnect your Notion account — refresh token rejected.',
        },
        message: `Notion token refresh failed (${response.status}): ${body}`,
      });
    }
    throw new NotionApiError({
      code: 'PROVIDER_ERROR',
      action: { type: 'auto_retry', description: 'Notion OAuth temporarily unavailable.' },
      message: `Notion token refresh failed (${response.status}): ${body}`,
    });
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // Persist rotated credentials so the next call (this worker or another)
  // reads the fresh ACCESS_TOKEN. Notion rotates `refresh_token` on every
  // refresh; if we don't capture it we permanently lose the ability to refresh.
  const updated: Record<string, string> = { ACCESS_TOKEN: data.access_token };
  if (data.refresh_token) updated.REFRESH_TOKEN = data.refresh_token;
  if (data.expires_in) {
    updated.EXPIRY_DATE = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  await context.updateUserSecrets(updated);

  return data.access_token;
}

/**
 * Build a Notion SDK Client wired with a refresh-on-401 fetch hook.
 *
 * Behaviour of the hook (one call site per tool invocation):
 *   - First attempt with the current token from disk.
 *   - On 401: refresh the access token, retry the SAME request once with the
 *     fresh `Authorization` header. If the retry also returns 401, surface it
 *     unchanged — the SDK will throw an `APIResponseError` and `wrapNotionCall`
 *     classifies it as AUTH_EXPIRED (with the `Reconnect` action).
 *   - Subsequent SDK calls within the same tool invocation reuse the closure-
 *     captured `currentToken`, so a single refresh covers a sequence of
 *     dependent calls (e.g. resolve dataSourceId → query → page lookup).
 */
export async function getNotionClient(context: ToolContext): Promise<Client> {
  const secrets = await loadNotionSecrets(context);

  if (!secrets.ACCESS_TOKEN) {
    throw new NotionApiError({
      code: 'AUTH_REQUIRED',
      action: {
        type: 'user_action',
        description: 'Connect your Notion account via OAuth.',
      },
      message: 'Notion account not connected. Please connect your Notion account.',
    });
  }

  let currentToken = secrets.ACCESS_TOKEN;

  // The Notion SDK already injects a lowercase `authorization` header (from the
  // `auth` option). We must REPLACE it case-insensitively, never add a second
  // `Authorization`: a plain object carrying both casings is merged by
  // `new Headers()` into `"Bearer X, Bearer X"`, which Notion rejects with
  // `API token is invalid`. `Headers.set` collapses to a single header.
  const withAuth = (init: NotionFetchInit | undefined, token: string): Headers => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return headers;
  };

  const customFetch: NotionFetch = async (url, init) => {
    const response = await fetch(url, { ...init, headers: withAuth(init, currentToken) });

    if (response.status !== 401) return response;

    // Refresh once. We deliberately do not loop — a second 401 after a fresh
    // token means the refresh token itself is dead; let the SDK throw and
    // `wrapNotionCall` route it as AUTH_EXPIRED → reconnect.
    currentToken = await refreshNotionAccessToken(context, secrets);

    return await fetch(url, { ...init, headers: withAuth(init, currentToken) });
  };

  return new Client({
    auth: currentToken,
    notionVersion: '2026-03-11',
    // The SDK's `SupportedFetch` is not re-exported in v5.20; the shape
    // matches but the structural typing has to be unblocked here.
    // biome-ignore lint/suspicious/noExplicitAny: see comment above
    fetch: customFetch as any,
    retry: false, // Delegated to wrapNotionCall in tools/utils.ts.
  });
}

/**
 * Validate Notion credentials by making a test API call. Goes through the
 * fetch hook, so a token close to expiry refreshes itself during validation.
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  const client = await getNotionClient(context);
  await client.users.me({});
}

// ============================================================================
// HELPER FUNCTIONS (unchanged from previous revision)
// ============================================================================

/**
 * Get all blocks from a page/block recursively
 */
export async function getAllBlocks(client: Client, blockId: string, depth = 0): Promise<any[]> {
  const maxDepth = 10;
  if (depth > maxDepth) return [];

  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      blocks.push(block);

      if (block.has_children) {
        const children = await getAllBlocks(client, block.id, depth + 1);
        block.children = children;
      }
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

/**
 * Format rich text array to plain text
 */
export function formatRichText(richTextArray: any[]): string {
  if (!richTextArray || !Array.isArray(richTextArray)) return '';
  return richTextArray.map((rt) => rt.plain_text).join('');
}

/**
 * Format blocks as readable text (markdown-like)
 */
export function formatBlocksAsText(blocks: any[], indent = 0, includeBlockIds = false): string {
  let text = '';
  const indentStr = '  '.repeat(indent);

  for (const block of blocks) {
    const type = block.type;

    if (includeBlockIds && indent === 0) {
      text += `<!-- block: ${block.id} -->\n`;
    }

    switch (type) {
      case 'paragraph':
        text += `${indentStr}${formatRichText(block.paragraph.rich_text)}\n`;
        break;
      case 'heading_1':
        text += `${indentStr}# ${formatRichText(block.heading_1.rich_text)}\n`;
        break;
      case 'heading_2':
        text += `${indentStr}## ${formatRichText(block.heading_2.rich_text)}\n`;
        break;
      case 'heading_3':
        text += `${indentStr}### ${formatRichText(block.heading_3.rich_text)}\n`;
        break;
      case 'heading_4':
        text += `${indentStr}#### ${formatRichText(block.heading_4.rich_text)}\n`;
        break;
      case 'bulleted_list_item':
        text += `${indentStr}- ${formatRichText(block.bulleted_list_item.rich_text)}\n`;
        break;
      case 'numbered_list_item':
        text += `${indentStr}1. ${formatRichText(block.numbered_list_item.rich_text)}\n`;
        break;
      case 'to_do': {
        const checked = block.to_do.checked ? 'x' : ' ';
        text += `${indentStr}[${checked}] ${formatRichText(block.to_do.rich_text)}\n`;
        break;
      }
      case 'toggle':
        text += `${indentStr}▶ ${formatRichText(block.toggle.rich_text)}\n`;
        break;
      case 'code': {
        const language = block.code.language;
        text += `${indentStr}\`\`\`${language}\n${formatRichText(block.code.rich_text)}\n${indentStr}\`\`\`\n`;
        break;
      }
      case 'quote':
        text += `${indentStr}> ${formatRichText(block.quote.rich_text)}\n`;
        break;
      case 'callout':
        text += `${indentStr}📌 ${formatRichText(block.callout.rich_text)}\n`;
        break;
      case 'divider':
        text += `${indentStr}---\n`;
        break;
      case 'meeting_notes': {
        const summary = formatRichText(block.meeting_notes?.summary ?? []);
        text += `${indentStr}🎙 Meeting notes${summary ? `: ${summary}` : ''}\n`;
        break;
      }
      default:
        text += `${indentStr}[${type}]\n`;
    }

    if (block.children && block.children.length > 0) {
      text += formatBlocksAsText(block.children, indent + 1, includeBlockIds);
    }
  }

  return text;
}
