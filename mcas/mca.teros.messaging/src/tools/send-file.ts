import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { basename, resolveUrl } from '../lib';

export const sendFile: ToolConfig = {
  description:
    'Send a document or file to the user. The file will be downloadable from the chat. Supports public URLs or local file paths.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public URL of the file (use this OR filePath)',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/document.pdf'). This is the shared volume accessible to all MCAs. Use this OR url.",
      },
      filename: {
        type: 'string',
        description:
          "Display name for the file (e.g., 'report.pdf'). Required if using url, optional for filePath.",
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the file',
      },
      mimeType: {
        type: 'string',
        description: "Optional MIME type (e.g., 'application/pdf')",
      },
      size: {
        type: 'number',
        description: 'Optional file size in bytes',
      },
    },
  },
  handler: async (args) => {
    const url = args?.url as string | undefined;
    const filePath = args?.filePath as string | undefined;
    const filename = args?.filename as string | undefined;
    const caption = args?.caption as string | undefined;
    const mimeType = args?.mimeType as string | undefined;
    const size = args?.size as number | undefined;

    // Filename is required for URL, optional for filePath (will use basename)
    if (url && !filename) {
      throw new Error('filename is required when using url');
    }

    const resolved = await resolveUrl(url, filePath, filename);
    const actualFilename = filename || (filePath ? basename(filePath) : 'file');

    return {
      success: true,
      __teros_message__: {
        type: 'file',
        url: resolved.url,
        filename: actualFilename,
        caption,
        mimeType: mimeType || resolved.mimeType,
        size: size || resolved.size,
      },
      description: `File sent: ${actualFilename}`,
    };
  },
};
