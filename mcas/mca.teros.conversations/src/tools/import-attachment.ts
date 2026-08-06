import type { HttpToolConfig as ToolConfig, ToolContext } from '@teros/mca-sdk';
import {
  CURRENT_CHANNEL_ID,
  getWsClient,
  type ImportAttachmentResult,
  isWsConnected,
} from '../lib';

export const importAttachment: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Copy a file the user uploaded in chat (image or document) into the agent workspace volume so filesystem tools can read it. Identify it by the filename shown in the "[User sent ...]" message reference. Returns { workspacePath, size, mime }.',
  parameters: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: 'Filename of the chat attachment to import, as shown in the message reference',
      },
      destPath: {
        type: 'string',
        description:
          'Optional destination path inside the workspace (relative). Defaults to the original filename at the workspace root.',
      },
      channelId: {
        type: 'string',
        description: 'Channel to import from. Defaults to the current conversation.',
      },
      messageId: {
        type: 'string',
        description: 'Optional message ID to disambiguate when several attachments share a filename.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite the destination if it already exists (default: false).',
      },
    },
    required: ['filename'],
  },
  handler: async (args, context: ToolContext) => {
    const wsClient = getWsClient();
    if (!isWsConnected()) {
      throw new Error('Not connected to backend. Please try again in a moment.');
    }

    const filename = args?.filename as string;
    if (!filename) {
      throw new Error('filename is required');
    }

    // Default to the channel the tool is running in (where the attachment was
    // uploaded). context.execution.channelId is the reliable per-call source for
    // HTTP/per-app MCAs; CURRENT_CHANNEL_ID (spawn-time env) is a last resort.
    const channelId =
      (args?.channelId as string) || context.execution.channelId || CURRENT_CHANNEL_ID || undefined;

    return wsClient.queryConversations<ImportAttachmentResult>('import_channel_attachment', {
      filename,
      channelId,
      messageId: args?.messageId as string | undefined,
      destPath: args?.destPath as string | undefined,
      overwrite: args?.overwrite === true,
      agentId: context.execution.agentId,
    });
  },
};
