import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const getAttachment: ToolConfig = {
  description:
    'Get details of a Zendesk attachment by ID. Returns { id, fileName, contentUrl, size, contentType, createdAt }.',
  parameters: {
    type: 'object',
    properties: {
      attachmentId: {
        type: 'string',
        description: 'Zendesk attachment ID.',
      },
    },
    required: ['attachmentId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { attachmentId } = args as { attachmentId: string };

    const result = (await zendeskRequest(
      context,
      `/attachments/${attachmentId}.json`,
    )) as any;
    const a = result.attachment;

    return {
      id: a.id,
      fileName: a.file_name,
      contentUrl: a.content_url,
      size: a.size,
      contentType: a.content_type,
      createdAt: a.created_at,
      thumbnails: (a.thumbnails ?? []).map((t: any) => ({
        id: t.id,
        contentUrl: t.content_url,
        width: t.width,
        height: t.height,
      })),
    };
  },
};
