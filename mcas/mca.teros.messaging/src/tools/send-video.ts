import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUrl } from '../lib';

export const sendVideo: ToolConfig = {
  description:
    'Send a video to the user. The video will be playable in the chat. Supports public URLs or local file paths.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public URL of the video (use this OR filePath)',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/video.mp4'). This is the shared volume accessible to all MCAs. Use this OR url.",
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the video',
      },
      duration: {
        type: 'number',
        description: 'Optional duration in seconds',
      },
      width: {
        type: 'number',
        description: 'Optional width in pixels',
      },
      height: {
        type: 'number',
        description: 'Optional height in pixels',
      },
      thumbnailUrl: {
        type: 'string',
        description: 'Optional URL for video thumbnail/preview image',
      },
      mimeType: {
        type: 'string',
        description: "Optional MIME type (e.g., 'video/mp4')",
      },
    },
  },
  handler: async (args) => {
    const url = args?.url as string | undefined;
    const filePath = args?.filePath as string | undefined;
    const caption = args?.caption as string | undefined;
    const duration = args?.duration as number | undefined;
    const width = args?.width as number | undefined;
    const height = args?.height as number | undefined;
    const thumbnailUrl = args?.thumbnailUrl as string | undefined;
    const mimeType = args?.mimeType as string | undefined;

    const resolved = await resolveUrl(url, filePath);

    return {
      success: true,
      __teros_message__: {
        type: 'video',
        url: resolved.url,
        caption,
        duration,
        width,
        height,
        thumbnailUrl,
        mimeType: mimeType || resolved.mimeType,
      },
      description: caption ? `Video sent: ${caption}` : 'Video sent to user',
    };
  },
};
