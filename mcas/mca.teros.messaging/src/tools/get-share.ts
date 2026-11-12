import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { basename } from '../lib';
import { callShareBackend } from '../lib/share-bridge';

/**
 * get-share — check whether a workspace file currently has a public share.
 *
 * Cheap read: returns { shared, shareId?, url? } without creating anything.
 */

export const getShare: ToolConfig = {
  description:
    'Check whether a file on the workspace volume currently has a PUBLIC share link. Returns { shared: boolean, shareId?, url? }. Use it to avoid creating a duplicate share, or to find the existing URL before revoking with unshare-file.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: "File path in /workspace/ (e.g., '/workspace/report.md').",
      },
      channelId: {
        type: 'string',
        description:
          'Channel that provides the workspace context. Defaults to the current conversation channel.',
      },
    },
    required: ['filePath'],
  },
  handler: async (args, context) => {
    const filePath = (args?.filePath as string | undefined)?.trim();
    const explicitChannelId = (args?.channelId as string | undefined)?.trim();

    if (!filePath) {
      throw new Error("filePath is required (e.g. '/workspace/report.md')");
    }

    const channelId = explicitChannelId || context.execution.channelId;

    const result = await callShareBackend<{ shared: boolean; shareId?: string; url?: string }>(
      context,
      'share.get',
      { filePath, ...(channelId ? { channelId } : {}) },
    );

    return {
      success: true,
      shared: result.shared,
      ...(result.shared ? { shareId: result.shareId, url: result.url } : {}),
      description: result.shared
        ? `${basename(filePath)} is publicly shared: ${result.url}`
        : `${basename(filePath)} is not shared.`,
    };
  },
};
