import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUrl } from '../lib';

export const sendImage: ToolConfig = {
  description:
    'Send an image to the user. The image will be displayed in the chat. Supports public URLs or local file paths.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public URL of the image (use this OR filePath)',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/image.png'). This is the shared volume accessible to all MCAs. Use this OR url.",
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the image',
      },
      width: {
        type: 'number',
        description: 'Optional width in pixels',
      },
      height: {
        type: 'number',
        description: 'Optional height in pixels',
      },
    },
  },
  handler: async (args) => {
    const url = args?.url as string | undefined;
    const filePath = args?.filePath as string | undefined;
    const caption = args?.caption as string | undefined;
    const width = args?.width as number | undefined;
    const height = args?.height as number | undefined;

    const resolved = await resolveUrl(url, filePath);

    return {
      success: true,
      __teros_message__: {
        type: 'image',
        url: resolved.url,
        caption,
        width,
        height,
        mimeType: resolved.mimeType,
      },
      description: caption ? `Image sent: ${caption}` : 'Image sent to user',
    };
  },
};
