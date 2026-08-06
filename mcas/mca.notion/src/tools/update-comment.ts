import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
import { COMMENT_FIELDS } from './_fields';
import { extractCommentShape, validateUuid } from './_notion-helpers';
import { resolveFields, wrapNotionCall } from './utils';

export const updateComment: ToolConfig = {
  description:
    'Edit an existing comment. Pass plain `text` for a simple string body, or `richText` for full Notion rich-text formatting. Returns the curated updated comment { id, plainText, lastEditedTime, ... }. Idempotent — safe to retry.',
  parameters: {
    type: 'object',
    properties: {
      commentId: { type: 'string', description: 'Comment UUID.' },
      text: { type: 'string', description: 'Plain text body. Mutually exclusive with richText.' },
      richText: {
        type: 'array',
        items: { type: 'object' },
        description: 'Notion rich text array. Mutually exclusive with text.',
      },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Notion comment object. Default false.',
      },
    },
    required: ['commentId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { commentId, text, richText, fields, includeRaw } = args as {
      commentId: string;
      text?: string;
      richText?: any[];
      fields?: string[];
      includeRaw?: boolean;
    };
    validateUuid(commentId, 'commentId');
    if (!text && !richText) {
      throw new Error('Either text or richText is required.');
    }
    if (text && richText) {
      throw new Error('Pass only one of text / richText.');
    }
    const rich_text = richText ?? [{ text: { content: text } }];

    const raw: any = await wrapNotionCall(() =>
      (client as any).comments.update({
        comment_id: commentId,
        rich_text,
      }),
    );
    const shape = extractCommentShape(raw);
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: COMMENT_FIELDS,
    });
  },
};
