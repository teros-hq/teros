import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';

export const createComment: ToolConfig = {
  description: 'Create a comment on a page or discussion.',
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'The page ID to comment on (optional if discussionId is provided)',
      },
      discussionId: {
        type: 'string',
        description: 'The discussion ID to comment on (optional if pageId is provided)',
      },
      text: {
        type: 'string',
        description: 'Comment text',
      },
    },
    required: ['text'],
  },
  handler: async (args, context) => {
    const client = await getNotionClient(context);

    const { pageId, discussionId, text } = args as {
      pageId?: string;
      discussionId?: string;
      text: string;
    };

    const commentParams: any = {
      rich_text: [{ text: { content: text } }],
    };

    if (pageId) {
      commentParams.parent = { page_id: pageId };
    } else if (discussionId) {
      commentParams.discussion_id = discussionId;
    } else {
      throw new Error('Either pageId or discussionId must be provided');
    }

    const comment = await client.comments.create(commentParams);
    return comment;
  },
};
