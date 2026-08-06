import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { resolveNotionId } from './_notion-helpers';
import { wrapNotionWrite } from './utils';

/**
 * Notion v5 `pages.updateMarkdown` accepts four discriminated body shapes:
 *   - { type: 'replace_content', replace_content: { new_str, allow_deleting_content? } }
 *   - { type: 'insert_content',  insert_content:  { content, after? } }
 *   - { type: 'replace_content_range', replace_content_range: { content, content_range, ... } }
 *   - { type: 'update_content',  update_content:  { content_updates: [{ old_str, new_str, ... }] } }
 *
 * We expose the two most common modes and pick `replace_content` when the
 * caller passes a single `markdown` payload. Callers that need granular
 * editing pass `mode: 'update_content'` with `edits`.
 */
export const updatePageMarkdown: ToolConfig = {
  description:
    "Edit a page using markdown ops. Modes: 'replace' (default — overwrites the whole body with `markdown`), 'append' (adds `markdown` at the end, optional `afterBlockId`), 'edit' (apply per-string edits via `edits: [{oldStr, newStr, replaceAll?}]`). Returns { pageId, mode }. `replace` is destructive — not retryable.",
  parameters: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Page UUID.' },
      mode: {
        type: 'string',
        enum: ['replace', 'append', 'edit'],
        description: "'replace' (default) | 'append' | 'edit'.",
      },
      markdown: {
        type: 'string',
        description:
          'Markdown body for replace/append modes. Headings #/##/###/####, lists, code, callouts, tables supported.',
      },
      afterBlockId: {
        type: 'string',
        description: 'Append mode only — block UUID after which to insert. Default: end of page.',
      },
      edits: {
        type: 'array',
        items: { type: 'object' },
        description:
          "Edit mode only — array of [{ oldStr, newStr, replaceAll? }] applied in order against the page's current markdown.",
      },
      allowDeletingContent: {
        type: 'boolean',
        description: 'Replace/edit modes — must be true to allow shrinking the page. Default true.',
      },
    },
    required: ['pageId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const {
      pageId: rawPageId,
      mode = 'replace',
      markdown,
      afterBlockId,
      edits,
      allowDeletingContent = true,
    } = args as {
      pageId: string;
      mode?: 'replace' | 'append' | 'edit';
      markdown?: string;
      afterBlockId?: string;
      edits?: Array<{ oldStr: string; newStr: string; replaceAll?: boolean }>;
      allowDeletingContent?: boolean;
    };
    const pageId = resolveNotionId(rawPageId, 'pageId');

    let body: Record<string, unknown>;
    if (mode === 'replace') {
      if (typeof markdown !== 'string') {
        throw new Error('replace mode requires `markdown: string`.');
      }
      body = {
        type: 'replace_content',
        replace_content: { new_str: markdown, allow_deleting_content: allowDeletingContent },
      };
    } else if (mode === 'append') {
      if (typeof markdown !== 'string') {
        throw new Error('append mode requires `markdown: string`.');
      }
      const insert: Record<string, unknown> = { content: markdown };
      if (afterBlockId) insert.after = afterBlockId;
      body = { type: 'insert_content', insert_content: insert };
    } else if (mode === 'edit') {
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('edit mode requires `edits: [{ oldStr, newStr, replaceAll? }]`.');
      }
      body = {
        type: 'update_content',
        update_content: {
          content_updates: edits.map((e) => ({
            old_str: e.oldStr,
            new_str: e.newStr,
            replace_all_matches: e.replaceAll ?? false,
          })),
          allow_deleting_content: allowDeletingContent,
        },
      };
    } else {
      throw new Error(`Unsupported mode "${mode}". Use 'replace' | 'append' | 'edit'.`);
    }

    await wrapNotionWrite(() => (client as any).pages.updateMarkdown({ page_id: pageId, ...body }));

    return { pageId, mode };
  },
};
