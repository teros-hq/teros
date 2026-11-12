import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { basename } from '../lib';
import { callShareBackend } from '../lib/share-bridge';

/**
 * unshare-file — revoke a public share link (by shareId or filePath).
 *
 * After revocation the URL stops serving content (404 page) immediately.
 */

export const unshareFile: ToolConfig = {
  description:
    'Revoke a PUBLIC share link created with share-file. Pass the shareId returned by share-file, or the filePath (the share is looked up in the current workspace). After revocation the URL returns a 404 page — nobody can access the content anymore. The link is public until revoked, so revoke it as soon as sharing is no longer needed.',
  parameters: {
    type: 'object',
    properties: {
      shareId: {
        type: 'string',
        description: 'Share ID returned by share-file (use this OR filePath).',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ whose share should be revoked (use this OR shareId). Resolved against the current workspace.",
      },
      channelId: {
        type: 'string',
        description:
          'Channel that provides the workspace context (required with filePath when not called from a channel).',
      },
    },
  },
  handler: async (args, context) => {
    const shareId = (args?.shareId as string | undefined)?.trim();
    const filePath = (args?.filePath as string | undefined)?.trim();
    const explicitChannelId = (args?.channelId as string | undefined)?.trim();

    if (!shareId && !filePath) {
      throw new Error("Provide either 'shareId' OR 'filePath' to revoke");
    }

    const channelId = explicitChannelId || context.execution.channelId;

    const result = await callShareBackend<{ ok: boolean; shareId: string }>(
      context,
      'share.revoke',
      {
        ...(shareId ? { shareId } : {}),
        ...(filePath ? { filePath } : {}),
        ...(channelId ? { channelId } : {}),
      },
    );

    return {
      success: true,
      shareId: result.shareId,
      description: filePath
        ? `Public share revoked for ${basename(filePath)} — the URL now returns 404.`
        : `Public share ${result.shareId} revoked — the URL now returns 404.`,
    };
  },
};
