import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { basename, extname } from '../lib';
import { callShareBackend } from '../lib/share-bridge';

/**
 * share-file — create a PUBLIC share link for a workspace file.
 *
 * The link is PUBLIC: anyone who has the URL can view the file content until
 * the share is revoked (unshare-file). The backend resolves the workspace from
 * the channel and records the share under the turn user's identity, so the
 * FileViewer shows the same "shared" state as a user-created share.
 */

export interface ShareFileResult {
  success: boolean;
  shareId: string;
  url: string;
  fileType: 'html' | 'markdown' | 'file';
  warning?: string;
  description: string;
}

/** Extension → share fileType (mirrors the backend's rendering rules). */
export function detectFileType(filePath: string): 'html' | 'markdown' | 'file' {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'file';
}

export const shareFile: ToolConfig = {
  description:
    'Create a PUBLIC share link for a file on the workspace volume. ⚠️ The URL is PUBLIC: ANYONE who has it can view the file content (markdown rendered as a page, HTML as-is, other types served directly) until the share is revoked with unshare-file. Returns { shareId, url } — send the url to the user or via whatsapp send-text / any channel. The FileViewer will show the file as shared. Prefer markdown (.md) or HTML files for readable shared pages.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/report.md'). Must be on the shared workspace volume.",
      },
      channelId: {
        type: 'string',
        description:
          'Channel that provides the workspace context (e.g. ch_xxx). Defaults to the current conversation channel.',
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
    if (!filePath.startsWith('/workspace/')) {
      throw new Error(
        `filePath must be on the shared workspace volume (/workspace/...). Got: ${filePath}`,
      );
    }

    const channelId = explicitChannelId || context.execution.channelId;
    if (!channelId) {
      throw new Error(
        'channelId is required when the tool is not called from a channel — pass the channelId of a conversation in the workspace.',
      );
    }

    const fileType = detectFileType(filePath);

    const result = await callShareBackend<{ shareId: string; url: string }>(
      context,
      'share.create',
      { filePath, channelId, fileType },
    );

    const filename = basename(filePath);
    const warning =
      fileType === 'file'
        ? 'This file type is served as-is (download/inline view) — markdown (.md) and HTML (.html) render as styled pages.'
        : undefined;

    return {
      success: true,
      shareId: result.shareId,
      url: result.url,
      fileType,
      ...(warning ? { warning } : {}),
      description: `Public share created for ${filename}: ${result.url}`,
    } satisfies ShareFileResult;
  },
};
