/**
 * Notion API Client Manager
 *
 * Manages authentication and API requests for Notion API.
 * Uses Internal Integration Token (API_TOKEN) from user secrets.
 */

import { Client } from '@notionhq/client';
import type { HttpToolContext as ToolContext } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface NotionSecrets {
  ACCESS_TOKEN?: string;
}

// =============================================================================
// SINGLETON STATE
// =============================================================================

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

/**
 * Get or create a Notion client with credentials from context
 */
export async function getNotionClient(context: ToolContext): Promise<Client> {
  const userSecrets = (await context.getUserSecrets()) as NotionSecrets;
  const apiToken = userSecrets.ACCESS_TOKEN;

  if (!apiToken) {
    throw new Error(
      'Notion account not connected. Please connect your Notion account via OAuth.',
    );
  }

  // Return cached client if token hasn't changed
  if (cachedClient && cachedToken === apiToken) {
    return cachedClient;
  }

  // Create new client
  cachedClient = new Client({ auth: apiToken });
  cachedToken = apiToken;

  return cachedClient;
}

/**
 * Validate Notion credentials by making a test API call
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  const client = await getNotionClient(context);
  await client.users.me({});
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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
export function formatBlocksAsText(blocks: any[], indent = 0): string {
  let text = '';
  const indentStr = '  '.repeat(indent);

  for (const block of blocks) {
    const type = block.type;

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
      default:
        text += `${indentStr}[${type}]\n`;
    }

    if (block.children && block.children.length > 0) {
      text += formatBlocksAsText(block.children, indent + 1);
    }
  }

  return text;
}
