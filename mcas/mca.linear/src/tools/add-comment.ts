import type { ToolConfig } from '@teros/mca-sdk';
import { getLinearClient } from '../lib';
import { COMMENT_FIELDS } from './_fields';
import { extractCommentShape, validateIssueId } from './_linear-helpers';
import { resolveFields } from './utils';

export const addComment: ToolConfig = {
  description:
    'Add a comment to a Linear issue. Returns curated { id, body, authorId, authorName, issueId, url, createdAt }. Not retryable. Params: issueId, body, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      issueId: { type: 'string', description: 'Issue UUID or identifier.' },
      body: { type: 'string', description: 'Markdown comment body.' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Override default whitelist.',
      },
      includeRaw: {
        type: 'boolean',
        description: 'Return raw Linear comment object. Default false.',
      },
    },
    required: ['issueId', 'body'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const client = await getLinearClient(context);
    const { issueId, body, fields, includeRaw } = args as {
      issueId: string;
      body: string;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateIssueId(issueId);

    const issue = await client.issue(issueId);
    const response = await client.createComment({ issueId: issue.id, body });
    const raw = await response.comment;
    if (!raw) throw new Error('Linear createComment did not return a comment');

    const [user, issueRef] = await Promise.all([raw.user, raw.issue]);
    const shape = extractCommentShape(raw, { user, issue: issueRef });
    return resolveFields(shape as any, raw, {
      includeRaw,
      fields,
      defaultFields: COMMENT_FIELDS,
    });
  },
};
